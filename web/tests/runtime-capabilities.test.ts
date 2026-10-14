import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeLabel, runtimeFeature, settingAvailable, settingForRoute, emailNotificationsMounted, type RuntimeManifest } from '../src/runtimeCapabilities.ts';

test('deployment labels do not imply adapters or grant settings authority', () => {
  for (const runtimeProfile of ['portable', 'local', 'docker', 'kubernetes', 'cloudflare-bridge', 'cloudflare-native']) {
    const manifest: RuntimeManifest = { runtimeProfile, capabilities: [{ id: 'settings.runners', state: 1, reason: 'unallocated' }] };
    assert.equal(settingAvailable(manifest, 'settings.runners'), false);
    manifest.capabilities[0]!.state = 3;
    assert.equal(settingAvailable(manifest, 'settings.runners'), true);
    assert.notEqual(runtimeLabel(runtimeProfile), 'Unreported runtime');
  }
  assert.equal(settingAvailable(undefined, 'settings.runners'), false);
  assert.equal(settingAvailable({ runtimeProfile: '', capabilities: [{ id: 'settings.runners', state: 3, reason: '' }] }, 'settings.runners'), false);
  assert.equal(settingAvailable({ runtimeProfile: 'unknown', capabilities: [{ id: 'settings.runners', state: 3, reason: '' }] }, 'settings.runners'), false);
});

test('direct settings URLs use the same capability contract as menus', () => {
  assert.equal(settingForRoute('instance-settings', 'infrastructure'), 'settings.infrastructure');
  assert.equal(settingForRoute('instance-settings', 'notifications'), 'settings.notifications');
  assert.equal(settingForRoute('repository-runners'), 'settings.runners');
  assert.equal(settingForRoute('account-security'), 'settings.local-auth');
  const native = { runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'settings.native', state: 'CAPABILITY_STATE_READY', reason: '' }] };
  assert.equal(settingAvailable(native, 'settings.native'), true);
  assert.equal(settingAvailable(native, settingForRoute('instance-settings', 'infrastructure')!), false);
  native.capabilities[0]!.state = 'CAPABILITY_STATE_DEGRADED';
  assert.equal(settingAvailable(native, 'settings.native'), false);
});

test('native email mounts while configured or ready, never when disabled or unreported', () => {
  const native = (state: number | string) => ({ runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'repository.email-notifications', state, reason: '' }] });
  for (const state of [3, 4, 'CAPABILITY_STATE_READY', 'CAPABILITY_STATE_DEGRADED']) assert.equal(emailNotificationsMounted(native(state)), true, String(state));
  for (const state of [0, 1, 2, 'CAPABILITY_STATE_DISABLED', 'CAPABILITY_STATE_UNCONFIGURED', 'CAPABILITY_STATE_UNSPECIFIED']) assert.equal(emailNotificationsMounted(native(state)), false, String(state));
  assert.equal(emailNotificationsMounted({ runtimeProfile: 'cloudflare-native', capabilities: [] }), false);
  assert.equal(emailNotificationsMounted({ runtimeProfile: 'cloudflare-native', capabilities: [{ id: 'settings.repository-webhooks', state: 3, reason: '' }] }), false);
  assert.equal(emailNotificationsMounted(undefined), false);
  assert.equal(emailNotificationsMounted({ runtimeProfile: 'docker', capabilities: [] }), true);
  // Degraded stays unavailable everywhere else.
  assert.equal(settingAvailable(native(4), 'repository.email-notifications'), false);
});

test('native feature mounts and direct settings routes require reported support', () => {
  const native = {runtimeProfile:'cloudflare-native',capabilities:[{id:'settings.repository-general',state:3,reason:''}]};
  assert.equal(settingForRoute('repository-settings',undefined,true),'settings.repository-general');
  assert.equal(settingForRoute('repository-access-settings',undefined,true),'settings.repository-access');
  assert.equal(settingForRoute('repository-access-settings'),null);
  assert.equal(runtimeFeature(native,'settings.repository-general'),true);
  assert.equal(runtimeFeature(native,'repository.source-write'),false);
  assert.equal(runtimeFeature(undefined,'repository.source-write'),false);
  assert.equal(runtimeFeature({runtimeProfile:'docker',capabilities:[]},'repository.source-write'),true);
});


test('native operations route is available explicitly while unsupported portable administration stays gated',()=>{
 assert.equal(settingForRoute('instance-settings','operations',true),'operations.dashboard');
 assert.equal(settingForRoute('instance-settings','runners',true),'settings.native-runners');
 assert.equal(settingForRoute('repository-runners',undefined,true),'settings.runners');
 for(const view of ['execution','organizations','agents'])assert.ok(settingForRoute('instance-settings',view,true)?.startsWith('settings.'));
 assert.equal(settingForRoute('instance-settings','overview',true),null);
});
