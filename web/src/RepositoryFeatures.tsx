import { useState, type ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryFeatureClient } from './featurePolicyApi';
import { FeatureDecider, type RepositoryFeature } from './gen/golf/v1/feature_policy_pb';
import { errorMessage } from './api';
import { holdErrorOnFocus, Loading, PanelError } from './RepositoryUI';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { settingAvailable } from './runtimeCapabilities';

const featuresKey = (userId: string, owner: string, name: string) => ['repository', userId, owner, name, 'features'];
// The effective feature state of one repository. The portable server answers Unimplemented and callers keep their
// current behaviour; any other failure also falls back, so a policy read never hides a page on its own.
export function useRepositoryFeatures(userId: string, owner: string, name: string, enabled = true) {
  // Only an installation that reports feature policies is asked; others never receive the probe.
  const runtime = useRuntimeCapabilities(), reported = settingAvailable(runtime.isError ? undefined : runtime.data, 'settings.feature-policy');
  return useQuery({ queryKey: featuresKey(userId, owner, name), enabled: enabled && reported && Boolean(userId), staleTime: 15_000, gcTime: 60_000, retry: false, ...holdErrorOnFocus,
    queryFn: ({ signal }) => repositoryFeatureClient.getRepositoryFeatures({ repository: { owner, name } }, { signal, timeoutMs: 8_000 }) });
}

export const deciderLabels: Record<FeatureDecider, string> = { [FeatureDecider.UNSPECIFIED]: 'Not reported', [FeatureDecider.OPERATOR]: 'Not allocated', [FeatureDecider.INSTALLATION]: 'Installation policy',
  [FeatureDecider.ORGANIZATION]: 'Organization policy', [FeatureDecider.REPOSITORY]: 'This repository', [FeatureDecider.DEPENDENCY]: 'Needs another feature' };

// A feature a policy turned off for this repository. Unallocated features stay with the capability list, which already explains them.
export function policyOff(features: RepositoryFeature[] | undefined, id: string) {
  const feature = features?.find(item => item.feature === id);
  return feature && !feature.effective && feature.decidedBy !== FeatureDecider.OPERATOR ? feature : undefined;
}

function StateChip({ feature }: { feature: RepositoryFeature }) {
  if (feature.decidedBy === FeatureDecider.OPERATOR) return <span className="visibility unallocated">Unavailable</span>;
  if (!feature.effective) return <span className="visibility configured">Off</span>;
  return <span className={`visibility ${feature.required ? 'available' : ''}`}>{feature.required ? 'Required' : 'On'}</span>;
}

const groups = ['Collaboration', 'Automation', 'Integrations', 'Distribution'];
// details renders settings beyond on/off under a feature (for example a model choice where the installation allows overriding it).
export function RepositoryFeaturesPanel({ userId, owner, name, signingOut, details }: { userId: string; owner: string; name: string; signingOut: boolean; details?: (feature: RepositoryFeature) => ReactNode }) {
  const client = useQueryClient(), query = useRepositoryFeatures(userId, owner, name, !signingOut);
  const [editing, setEditing] = useState(false), [pending, setPending] = useState(false), [notice, setNotice] = useState<{ text: string; failed: boolean }>();
  const data = query.data, changeable = data?.features.filter(feature => feature.canChange) ?? [];
  const form = useForm({ defaultValues: { enabled: {} as Record<string, boolean> }, onSubmit: async ({ value }) => {
    if (!data) return;
    const changes = changeable.filter(feature => (value.enabled[feature.feature] ?? feature.repositoryEnabled) !== feature.repositoryEnabled).map(feature => ({ feature: feature.feature, enabled: !feature.repositoryEnabled }));
    if (!changes.length) { setNotice({ text: 'Change a feature before saving.', failed: true }); return; }
    setPending(true); setNotice(undefined);
    try {
      const saved = await repositoryFeatureClient.updateRepositoryFeatures({ repository: { owner, name }, repositoryId: data.repositoryId, expectedRevision: data.revision, changes }, { timeoutMs: 12_000 });
      if (saved.repositoryId !== data.repositoryId || changes.some(change => saved.features.find(feature => feature.feature === change.feature)?.repositoryEnabled !== change.enabled)) throw new Error('The saved features could not be verified. Refresh and inspect them.');
      await client.invalidateQueries({ queryKey: ['repository', userId, owner, name] });
      setEditing(false); setNotice({ text: `Saved: ${changes.map(change => `${data.features.find(feature => feature.feature === change.feature)?.label} ${change.enabled ? 'on' : 'off'}`).join(', ')}.`, failed: false });
    } catch (error) { setNotice({ text: `${errorMessage(error instanceof Error ? error : new Error(String(error)))} Nothing was retried; refresh before another change.`, failed: true }); }
    finally { setPending(false); }
  } });
  // The portable server has no feature store yet: the section is not shown there.
  if (query.error instanceof ConnectError && query.error.code === Code.Unimplemented) return null;
  return <section className="browser-panel credential-list-panel" aria-labelledby="repository-features-title">
    <div className="browser-panel-heading"><h2 id="repository-features-title">Features</h2>{data?.canEdit && changeable.length && !editing ? <button type="button" className="button secondary policy-edit" disabled={pending || signingOut || query.isFetching} onClick={() => { form.reset(); setEditing(true); setNotice(undefined); }}>Edit features</button> : null}</div>
    {notice ? <p className={notice.failed ? 'error' : 'policy-notice'} role={notice.failed ? 'alert' : 'status'}>{notice.text}</p> : null}
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !data ? <Loading label="Reading repository features…" /> : editing ? <form className="credential-form-content" aria-label="Repository features editor" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <fieldset className="policy-choices policy-toggles" disabled={pending}><legend>Turn features on or off for this repository. A feature you turn off keeps its data.</legend>
        {changeable.map(feature => <form.Field key={feature.feature} name={`enabled.${feature.feature}`}>{field => <label className="policy-choice"><input type="checkbox" checked={field.state.value ?? feature.repositoryEnabled} onChange={event => field.handleChange(event.target.checked)} /><span><strong>{feature.label}</strong><small>{feature.requires.length ? `Needs ${feature.requires.map(id => data.features.find(item => item.feature === id)?.label || id).join(' and ')}.` : 'This repository decides.'}</small></span></label>}</form.Field>)}
      </fieldset>
      {data.features.some(feature => !feature.canChange && feature.decidedBy !== FeatureDecider.OPERATOR) ? <p className="field-help">Decided by a policy, not here: {data.features.filter(feature => !feature.canChange && feature.decidedBy !== FeatureDecider.OPERATOR).map(feature => `${feature.label} (${feature.effective ? feature.required ? 'required' : 'on' : 'off'}, ${deciderLabels[feature.decidedBy].toLowerCase()})`).join(', ')}.</p> : null}
      <p className="field-help">Turning a feature off removes its tab and settings here and refuses its requests and queued work; turning it back on restores them. Actions uses the same switch as Automation settings.</p>
      <div className="credential-actions"><button className="button primary" disabled={pending}>{pending ? 'Saving…' : 'Save features'}</button><button type="button" className="button secondary" disabled={pending} onClick={() => setEditing(false)}>Cancel</button></div>
    </form> : <>{groups.map(group => { const items = data.features.filter(feature => feature.group === group); return items.length ? <div key={group} className="policy-feature-group"><h3>{group}</h3><ul className="policy-list">{items.map(feature => <li key={feature.feature} className="policy-row">
        <div className="policy-row-main"><div className="policy-row-title"><h4>{feature.label}</h4><StateChip feature={feature} /><span className="policy-decider">{deciderLabels[feature.decidedBy]}</span></div><p className="policy-row-detail">{feature.reason}</p>{details?.(feature)}</div>
      </li>)}</ul></div> : null; })}
      <p className="panel-footnote">Installation administrators decide which features exist and which are required; you choose within that. Features the operator has not allocated are listed as unavailable.</p></>}
  </section>;
}
