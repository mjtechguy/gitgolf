import type { Page } from '@playwright/test';
import { GetSessionResponseSchema, ListCapabilitiesResponseSchema, GetRepositorySettingsResponseSchema, GetRepositoryAccessResponseSchema, RepositoryFeatureMode, GetExecutionPolicyResponseSchema, ExecutionScope, ExecutionMode } from '../src/gen/golf/v1/golf_pb';
import { GetFeaturePolicyResponseSchema, UpdateFeaturePolicyRequestSchema, UpdateFeaturePolicyResponseSchema, GetRepositoryFeaturesResponseSchema, UpdateRepositoryFeaturesRequestSchema, UpdateRepositoryFeaturesResponseSchema, FeaturePolicyMode, FeatureDecider } from '../src/gen/golf/v1/feature_policy_pb';
import { fixture as layout } from './layout-fixture';
import { reject, request, respond } from './rpc';

// A Cloudflare-native installation as the Worker reports it: the same catalogue, levels and reasons as cloudflare/forge/src/feature-policy.mjs.
type Feature = { feature: string; label: string; plural?: boolean; group: string; requires: string[]; choice: boolean; unavailable?: string; reach: number };
export const catalogue: Feature[] = [
  { feature: 'pull-requests', label: 'Pull requests', plural: true, group: 'Collaboration', requires: [], choice: true, reach: 14 },
  { feature: 'issues', label: 'Issues', plural: true, group: 'Collaboration', requires: [], choice: true, reach: 13 },
  { feature: 'actions', label: 'Actions', group: 'Automation', requires: ['pull-requests'], choice: true, reach: 12 },
  { feature: 'secrets', label: 'Secrets and variables', plural: true, group: 'Automation', requires: ['actions'], choice: true, reach: 9 },
  { feature: 'previews', label: 'Previews and environments', plural: true, group: 'Automation', requires: ['actions'], choice: true, reach: 11 },
  { feature: 'agents', label: 'Agent proposals', plural: true, group: 'Automation', requires: ['actions', 'pull-requests'], choice: true, reach: 0, unavailable: 'The operator has not allocated native agent proposals on this installation.' },
  { feature: 'advice', label: 'AI review advice', group: 'Automation', requires: ['pull-requests'], choice: true, reach: 7 },
  { feature: 'merge', label: 'Merge', group: 'Collaboration', requires: ['pull-requests'], choice: true, reach: 14 },
  { feature: 'attachments', label: 'Discussion attachments', plural: true, group: 'Collaboration', requires: [], choice: true, reach: 14 },
  { feature: 'wiki', label: 'Wiki', group: 'Collaboration', requires: [], choice: false, reach: 0, unavailable: 'Cloudflare native has no wiki service yet.' },
  { feature: 'webhooks', label: 'Webhooks', plural: true, group: 'Integrations', requires: [], choice: true, reach: 6 },
  { feature: 'email', label: 'Email notifications', plural: true, group: 'Integrations', requires: [], choice: true, reach: 14 },
  { feature: 'releases', label: 'Releases', plural: true, group: 'Distribution', requires: [], choice: true, reach: 10 },
  { feature: 'packages', label: 'Packages', plural: true, group: 'Distribution', requires: [], choice: true, reach: 0, unavailable: 'The operator has not connected an OCI registry to this installation.' },
  { feature: 'public-repositories', label: 'Public repositories', plural: true, group: 'Distribution', requires: [], choice: false, reach: 3 },
];
const capabilities = ['settings.repository-general', 'settings.repository-access', 'settings.repository-git', 'settings.repository-rules', 'settings.repository-workflows', 'settings.native-runners', 'settings.repository-secrets', 'settings.repository-environments', 'settings.repository-webhooks', 'repository.releases', 'repository.public-source', 'settings.feature-policy', 'operations.dashboard', 'settings.native', 'pull.merge'];
const capabilityFeature: Record<string, string> = { 'settings.repository-secrets': 'secrets', 'settings.repository-environments': 'previews', 'settings.repository-webhooks': 'webhooks', 'repository.releases': 'releases', 'repository.public-source': 'public-repositories', 'pull.merge': 'merge' };
const total = 14, be = (f: Feature) => f.plural ? 'are' : 'is';

export async function featureBackend(page: Page) {
  const state = { modes: { releases: 'DISABLED' } as Record<string, 'DISABLED' | 'ALLOWED' | 'ENFORCED'>, versions: { releases: 1 } as Record<string, number>, repository: { webhooks: false } as Record<string, boolean>,
    updates: [] as unknown[], repositoryUpdates: [] as unknown[], executionUpdates: 0, revision: 1 };
  const effective = (subject: string) => {
    const result = new Map<string, { effective: boolean; decidedBy: FeatureDecider; reason: string; enabled: boolean; canChange: boolean }>();
    for (const f of catalogue) {
      const mode = state.modes[f.feature] || 'ALLOWED', enabled = !f.choice || state.repository[f.feature] !== false, blocked = f.requires.map(id => [id, result.get(id)!] as const).find(([, r]) => !r.effective);
      const off = (decidedBy: FeatureDecider, reason: string) => result.set(f.feature, { effective: false, decidedBy, reason, enabled, canChange: f.choice && !f.unavailable && mode === 'ALLOWED' });
      if (f.unavailable) off(FeatureDecider.OPERATOR, f.unavailable);
      else if (mode === 'DISABLED') off(FeatureDecider.INSTALLATION, `${f.label} ${be(f)} turned off for ${subject} by the installation policy.`);
      else if (mode !== 'ENFORCED' && !enabled) off(FeatureDecider.REPOSITORY, `${f.label} ${be(f)} turned off for ${subject} by the repository policy.`);
      else if (blocked) off(FeatureDecider.DEPENDENCY, `${f.label} ${be(f)} turned off for ${subject} because ${catalogue.find(c => c.feature === blocked[0])!.label} is off (${blocked[1].decidedBy === FeatureDecider.REPOSITORY ? 'repository' : 'installation'} policy).`);
      else result.set(f.feature, { effective: true, decidedBy: mode === 'ENFORCED' ? FeatureDecider.INSTALLATION : f.choice ? FeatureDecider.REPOSITORY : FeatureDecider.INSTALLATION, enabled, canChange: f.choice && mode === 'ALLOWED',
        reason: mode === 'ENFORCED' ? `${f.label} ${be(f)} required for ${subject} by the installation policy.` : f.choice ? `${f.label} ${be(f)} on; the installation policy lets repository administrators turn ${f.plural ? 'them' : 'it'} off.` : `${f.label} ${be(f)} allowed by the installation policy.` });
    }
    return result;
  };
  const policy = (f: Feature) => ({ feature: f.feature, label: f.label, group: f.group, requires: f.requires, allocated: !f.unavailable, unavailableReason: f.unavailable || '', repositoryChoice: f.choice,
    mode: FeaturePolicyMode[state.modes[f.feature] || 'ALLOWED'], version: String(state.versions[f.feature] || 0), updatedBy: state.versions[f.feature] ? 'alex' : '', updatedAt: state.versions[f.feature] ? '2026-10-14T09:12:00Z' : '',
    repositoriesTotal: total, repositoriesOn: f.unavailable || state.modes[f.feature] === 'DISABLED' ? 0 : state.modes[f.feature] === 'ENFORCED' && f.feature !== 'public-repositories' ? total : f.reach });
  const features = () => [...effective('this repository')].map(([feature, value]) => { const f = catalogue.find(c => c.feature === feature)!; return { feature, label: f.label, group: f.group, requires: f.requires, effective: value.effective, decidedBy: value.decidedBy, reason: value.reason, repositoryEnabled: value.enabled, canChange: value.canChange, revision: '1' }; });
  await layout(page, true);
  await page.route('**/rpc/**', async route => {
    const method = route.request().url().split('/').at(-1)!;
    if (method === 'GetSession') return respond(route, GetSessionResponseSchema, { user: { id: '17', login: 'alex', fullName: 'Alex Morgan', isInstanceAdmin: true } });
    if (method === 'ListCapabilities') { const installation = effective('every repository'); return respond(route, ListCapabilitiesResponseSchema, { runtimeProfile: 'cloudflare-native', capabilities: capabilities.map(id => { const off = capabilityFeature[id] && installation.get(capabilityFeature[id]); return off && !off.effective && off.decidedBy !== FeatureDecider.OPERATOR ? { id, label: id, state: 1, reason: off.reason } : { id, label: id, state: 3, reason: 'Available.' }; }) }); }
    if (method === 'GetFeaturePolicy') return respond(route, GetFeaturePolicyResponseSchema, { scope: 1, policies: catalogue.map(policy), revision: String(state.revision), canEdit: true, lastChangedAt: '2026-10-14T09:12:00Z', lastChangedBy: 'alex' });
    if (method === 'UpdateFeaturePolicy') {
      const input = request(route, UpdateFeaturePolicyRequestSchema); state.updates.push(input);
      const mode = FeaturePolicyMode[input.mode] as 'DISABLED' | 'ALLOWED' | 'ENFORCED', before = state.modes[input.feature] || 'ALLOWED', rank = { DISABLED: 0, ALLOWED: 1, ENFORCED: 2 };
      if (input.expectedVersion !== String(state.versions[input.feature] || 0)) return reject(route, 'failed_precondition', 'Feature policy changed. Refresh before editing.');
      if (rank[mode] > rank[before] && input.confirmation !== input.feature) return reject(route, 'invalid_argument', `Type ${input.feature} to confirm.`);
      state.modes[input.feature] = mode; state.versions[input.feature] = (state.versions[input.feature] || 0) + 1; state.revision++;
      return respond(route, UpdateFeaturePolicyResponseSchema, { policy: policy(catalogue.find(f => f.feature === input.feature)!), revision: String(state.revision) });
    }
    if (method === 'GetRepositoryFeatures') return respond(route, GetRepositoryFeaturesResponseSchema, { repositoryId: '41', features: features(), revision: 'r'.repeat(8) + state.repositoryUpdates.length, canEdit: true });
    if (method === 'UpdateRepositoryFeatures') {
      const input = request(route, UpdateRepositoryFeaturesRequestSchema); state.repositoryUpdates.push(input);
      for (const change of input.changes) state.repository[change.feature] = change.enabled;
      return respond(route, UpdateRepositoryFeaturesResponseSchema, { repositoryId: '41', features: features(), revision: 'r'.repeat(8) + state.repositoryUpdates.length, canEdit: true });
    }
    if (method === 'GetRepositorySettings') return respond(route, GetRepositorySettingsResponseSchema, { settings: { repositoryId: '41', ownerId: '17', description: 'FastAPI framework, high performance, easy to learn, fast to code, ready for production.', website: 'https://fastapi.tiangolo.com', topics: ['api', 'python'], defaultBranch: 'main', canEdit: true, revision: 'a'.repeat(64), generalEditImplemented: true, issuesMode: RepositoryFeatureMode.INTERNAL, wikiMode: RepositoryFeatureMode.DISABLED, hasIssues: true, hasPullRequests: true } });
    if (method === 'GetRepositoryAccess') return respond(route, GetRepositoryAccessResponseSchema, { access: { repositoryId: '41', ownerId: '17', owner: { id: '17', login: 'alex' }, canManage: true, currentPermission: 'admin', revision: 'a'.repeat(64) } });
    if (method === 'GetExecutionPolicy') return respond(route, GetExecutionPolicyResponseSchema, { policy: { scope: ExecutionScope.REPOSITORY, scopeId: '41', mode: ExecutionMode.ALL, manualDispatchEnabled: true, pushAllowed: true, allowAllWorkflows: true, revision: '0', canEdit: true, authorityRevision: 'a'.repeat(64) } });
    if (['GetRepositoryVisibility', 'ListRepositoryReleases', 'GetRepositoryStar'].includes(method)) return reject(route, 'unimplemented', 'Not part of this fixture.');
    return route.fallback();
  });
  return state;
}
