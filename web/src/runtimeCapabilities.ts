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
export function settingForRoute(kind: string, view?: string, native = false) {
  if (native) {
    const repositoryRoutes: Record<string, string> = { 'repository-settings': 'general', 'repository-access-settings': 'access', 'repository-git': 'git', 'repository-rules': 'rules', 'repository-secrets': 'secrets', 'repository-environments': 'environments', 'repository-webhooks': 'webhooks', 'repository-workflows': 'workflows', 'repository-deletion': 'lifecycle' };
    if (repositoryRoutes[kind]) return 'settings.repository-' + repositoryRoutes[kind];
  }
  if (native && kind === 'instance-settings') {
    const nativeAdmin: Record<string, string> = { operations: 'operations.dashboard', execution: 'settings.execution', organizations: 'settings.organization-creation', agents: 'settings.agents-admin' };
    if (view && nativeAdmin[view]) return nativeAdmin[view];
  }
  if (kind === 'instance-settings') return view === 'infrastructure' ? 'settings.infrastructure' : view === 'runners' ? 'settings.runners' : view === 'notifications' ? 'settings.notifications' : view === 'accounts' || !view ? 'settings.local-auth' : null;
  if (kind === 'repository-runners') return 'settings.runners';
  if (['account-security', 'sessions', 'ssh-keys'].includes(kind)) return 'settings.local-auth';
  return null;
}
