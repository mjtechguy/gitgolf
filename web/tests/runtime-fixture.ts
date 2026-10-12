export const portableRuntimeFixture = {
  runtimeProfile: 'docker',
  capabilities: ['settings.infrastructure', 'settings.runners', 'settings.local-auth', 'settings.notifications', 'settings.cloudflare-resources'].map(id => ({ id, label: id, state: 3 as const, reason: 'Portable test installation supports this editor.' })),
};
