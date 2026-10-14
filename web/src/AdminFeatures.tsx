import { useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare, Package, Plug, RefreshCw, Workflow } from 'lucide-react';
import { featurePolicyClient } from './featurePolicyApi';
import { FeaturePolicyMode as Mode, FeaturePolicyScope, type FeaturePolicy } from './gen/golf/v1/feature_policy_pb';
import { SummaryBand } from './Layout';
import { DateLabel, Loading, PanelError } from './RepositoryUI';
import { errorMessage } from './api';

const groups = [
  ['Automation', Workflow, 'Pull-request runs and what they unlock.'],
  ['Collaboration', MessagesSquare, 'Discussion around issues and pull requests.'],
  ['Integrations', Plug, 'Signals sent outside this installation.'],
  ['Distribution', Package, 'What leaves a repository for others to use.'],
] as const;
export const modeNames: Record<Mode, string> = { [Mode.UNSPECIFIED]: 'Not reported', [Mode.DISABLED]: 'Off', [Mode.ALLOWED]: 'Allowed', [Mode.ENFORCED]: 'On everywhere' };
const rank = (mode: Mode) => mode === Mode.DISABLED ? 0 : mode === Mode.ALLOWED ? 1 : 2;
const plural = (count: number) => `${count} ${count === 1 ? 'repository' : 'repositories'}`;

export function PolicyChip({ policy }: { policy: FeaturePolicy }) {
  if (!policy.allocated) return <span className="visibility unallocated">Unavailable</span>;
  const tone = policy.mode === Mode.ENFORCED ? 'available' : policy.mode === Mode.DISABLED ? 'configured' : '';
  return <span className={`visibility ${tone}`}>{modeNames[policy.mode]}</span>;
}

// Reach counts active repositories where the feature is on now, after every level and dependency.
function Reach({ policy }: { policy: FeaturePolicy }) {
  if (!policy.allocated) return <p className="policy-row-detail">{policy.unavailableReason}</p>;
  const total = policy.repositoriesTotal, on = policy.repositoriesOn;
  const text = !total ? 'No repositories yet' : policy.mode === Mode.DISABLED ? `Off in all ${plural(total)}` : `${policy.feature === 'public-repositories' ? 'Public' : 'On'} in ${on} of ${plural(total)}`;
  return <p className="policy-row-detail policy-reach">{total ? <meter min={0} max={total} value={on} aria-hidden="true" /> : null}<span>{text}</span></p>;
}

function effect(policy: FeaturePolicy, mode: Mode, dependents: FeaturePolicy[]) {
  if (mode === Mode.DISABLED) return `Every repository loses ${policy.label} on its next request: the tab and settings disappear and requests are refused naming the installation policy. Queued work for it is refused or cancelled; nothing is deleted.${dependents.length ? ` Also turns off ${dependents.map(item => item.label).join(', ')}.` : ''}`;
  if (mode === Mode.ENFORCED) return `On for every repository, including any whose administrator turned it off; their choice is kept for when the policy returns to Allowed.`;
  return policy.repositoryChoice ? 'Each repository’s own choice applies: on unless its administrator turned it off. Organization policies are not available yet, so no other level narrows it.' : 'Available to every repository; each repository keeps its own setting for it.';
}

function PolicyEditor({ policy, dependents, pending, onSave, onCancel }: { policy: FeaturePolicy; dependents: FeaturePolicy[]; pending: boolean; onSave: (mode: Mode, confirmation: string) => void; onCancel: () => void }) {
  const form = useForm({ defaultValues: { mode: policy.mode, confirmation: '' }, onSubmit: ({ value }) => onSave(value.mode, value.confirmation) });
  const mode = useStore(form.store, state => state.values.mode), confirmation = useStore(form.store, state => state.values.confirmation);
  const widening = rank(mode) > rank(policy.mode), name = `policy-${policy.feature}`;
  const choices: [Mode, string][] = [[Mode.DISABLED, 'Off for every repository.'], [Mode.ALLOWED, policy.repositoryChoice ? 'Repository administrators turn it on or off.' : 'Every repository may use it.'], [Mode.ENFORCED, policy.feature === 'public-repositories' ? 'Never: each repository keeps its own visibility.' : 'On for every repository; it cannot be turned off.']];
  return <form className="policy-editor" aria-label={`${policy.label} policy`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <fieldset className="policy-choices" disabled={pending}><legend>Policy for {policy.label}</legend>
      {choices.map(([value, detail]) => <label key={value} className="policy-choice"><input type="radio" name={name} checked={mode === value} disabled={value === Mode.ENFORCED && policy.feature === 'public-repositories'} onChange={() => form.setFieldValue('mode', value)} /><span><strong>{modeNames[value]}</strong><small>{detail}</small></span></label>)}
    </fieldset>
    <p className="field-help">{mode === policy.mode ? 'Choose a different mode to change the policy.' : effect(policy, mode, mode === Mode.DISABLED ? dependents : [])}</p>
    {widening ? <form.Field name="confirmation">{field => <label className="policy-confirm">Type <code>{policy.feature}</code> to confirm turning it on<input autoComplete="off" spellCheck={false} value={field.state.value} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field> : null}
    <div className="credential-actions"><button className="button primary" disabled={pending || mode === policy.mode || widening && confirmation !== policy.feature}>{pending ? 'Saving…' : 'Save policy'}</button><button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function AdminFeatures({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['feature-policy', userId], staleTime: 0, gcTime: 0, retry: false, enabled: !signingOut,
    queryFn: ({ signal }) => featurePolicyClient.getFeaturePolicy({ scope: FeaturePolicyScope.INSTALLATION }, { signal, timeoutMs: 8_000 }) });
  const [editing, setEditing] = useState<string>(), [pending, setPending] = useState(false), [notice, setNotice] = useState<{ text: string; failed: boolean }>();
  const policies = query.data?.policies ?? [], allocated = policies.filter(policy => policy.allocated);
  async function save(policy: FeaturePolicy, mode: Mode, confirmation: string) {
    setPending(true); setNotice(undefined);
    try {
      const saved = await featurePolicyClient.updateFeaturePolicy({ scope: FeaturePolicyScope.INSTALLATION, feature: policy.feature, mode, expectedVersion: policy.version,
        confirmation: rank(mode) > rank(policy.mode) ? confirmation : '', operationId: crypto.randomUUID() }, { timeoutMs: 12_000 });
      if (saved.policy?.feature !== policy.feature || saved.policy.mode !== mode) throw new Error('The saved policy could not be verified. Refresh and inspect it.');
      setEditing(undefined); setNotice({ text: `${policy.label}: ${modeNames[mode].toLowerCase()} for every repository.`, failed: false });
      void client.invalidateQueries({ queryKey: ['capabilities'] }); void client.invalidateQueries({ queryKey: ['repository'] });
    } catch (error) { setNotice({ text: `${errorMessage(error instanceof Error ? error : new Error(String(error)))} Refresh before another change; nothing was retried.`, failed: true }); }
    finally { setPending(false); await query.refetch(); }
  }
  return <div className="page-stack">
    <div className="settings-toolbar"><p className="field-help">Organization policies are not available yet: this installation policy and each repository’s own choice decide.</p><button type="button" className="button secondary policy-refresh" disabled={query.isFetching || pending} onClick={() => void query.refetch()}><RefreshCw size={15} aria-hidden="true" />Refresh</button></div>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !query.data ? <Loading label="Reading feature policies…" /> : <>
      <SummaryBand label="Feature policy summary" items={[
        ['On everywhere', allocated.filter(policy => policy.mode === Mode.ENFORCED).length, 'Required for every repository'],
        ['Allowed', allocated.filter(policy => policy.mode === Mode.ALLOWED).length, 'Repositories choose'],
        ['Off', allocated.filter(policy => policy.mode === Mode.DISABLED).length, 'For every repository'],
        ['Unavailable', policies.length - allocated.length, 'Not allocated by the operator'],
        ['Last change', query.data.lastChangedAt ? <DateLabel value={query.data.lastChangedAt} /> : 'None yet', query.data.lastChangedBy ? `by ${query.data.lastChangedBy}` : 'Every feature is at its default'],
      ]} />
      {notice ? <p className={notice.failed ? 'error' : 'policy-notice'} role={notice.failed ? 'alert' : 'status'}>{notice.text}</p> : null}
      <div className="policy-groups">{groups.map(([group, Icon, detail]) => {
        const items = policies.filter(policy => policy.group === group);
        return items.length ? <section key={group} className="browser-panel policy-card" aria-labelledby={`policy-group-${group}`}>
          <div className="browser-panel-heading"><h2 id={`policy-group-${group}`}><Icon size={16} aria-hidden="true" />{group}</h2><span className="policy-card-note">{detail}</span></div>
          <ul className="policy-list">{items.map(policy => <li key={policy.feature} className="policy-row">
            <div className="policy-row-main"><div className="policy-row-title"><h3>{policy.label}</h3><PolicyChip policy={policy} /></div><Reach policy={policy} />
              {policy.requires.length ? <p className="policy-row-detail">Needs {policy.requires.map(id => policies.find(item => item.feature === id)?.label || id).join(' and ')}</p> : null}
              {policy.updatedAt ? <p className="policy-row-detail">Changed <DateLabel value={policy.updatedAt} /> by {policy.updatedBy}</p> : null}</div>
            {policy.allocated && query.data.canEdit && editing !== policy.feature ? <button type="button" className="button secondary policy-edit" aria-label={`Edit ${policy.label} policy`} disabled={pending || signingOut || Boolean(editing)} onClick={() => { setEditing(policy.feature); setNotice(undefined); }}>Edit</button> : null}
            {editing === policy.feature ? <PolicyEditor key={policy.version} policy={policy} dependents={policies.filter(item => item.requires.includes(policy.feature) && item.allocated)} pending={pending} onSave={(mode, confirmation) => void save(policy, mode, confirmation)} onCancel={() => setEditing(undefined)} /> : null}
          </li>)}</ul>
        </section> : null;
      })}</div>
      <p className="panel-footnote">Off removes a feature from every repository and refuses its requests and queued work; its data is kept. Allowed lets each repository administrator decide. On everywhere keeps it on even where an administrator turned it off. Organization policies are not available yet, so only this installation policy and each repository’s own choice apply. Unavailable features are not part of this deployment; the operator adds them at deploy time. Policy changes need an Access sign-in as an operations administrator; bearer and service tokens cannot change them.</p>
    </>}
  </div>;
}
