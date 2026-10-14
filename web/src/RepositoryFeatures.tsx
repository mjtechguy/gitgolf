import { useQuery } from '@tanstack/react-query';
import { repositoryFeatureClient } from './featurePolicyApi';
import { FeatureDecider, type RepositoryFeature } from './gen/golf/v1/feature_policy_pb';

// The effective feature state of one repository. The portable server answers Unimplemented and callers keep their
// current behaviour; any other failure also falls back, so a policy read never hides a page on its own.
export function useRepositoryFeatures(userId: string, owner: string, name: string, enabled = true) {
  return useQuery({ queryKey: ['repository', userId, owner, name, 'features'], enabled: enabled && Boolean(userId), staleTime: 15_000, gcTime: 60_000, retry: false,
    queryFn: ({ signal }) => repositoryFeatureClient.getRepositoryFeatures({ repository: { owner, name } }, { signal, timeoutMs: 8_000 }) });
}

export const deciderLabels: Record<FeatureDecider, string> = { [FeatureDecider.UNSPECIFIED]: 'Not reported', [FeatureDecider.OPERATOR]: 'Not allocated', [FeatureDecider.INSTALLATION]: 'Installation policy',
  [FeatureDecider.ORGANIZATION]: 'Organization policy', [FeatureDecider.REPOSITORY]: 'This repository', [FeatureDecider.DEPENDENCY]: 'Needs another feature' };

// A feature a policy turned off for this repository. Unallocated features stay with the capability list, which already explains them.
export function policyOff(features: RepositoryFeature[] | undefined, id: string) {
  const feature = features?.find(item => item.feature === id);
  return feature && !feature.effective && feature.decidedBy !== FeatureDecider.OPERATOR ? feature : undefined;
}
