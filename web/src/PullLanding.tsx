import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { DateLabel, privateQuery } from './RepositoryUI';
import { settingAvailable } from './runtimeCapabilities';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { agenticKey, decisionLabels, evaluateLanding, landKey, landPull, landStateLabels, landSummary, listLands, readAgentic, riskLabels, type LandMethod } from './agenticMode';

// Agentic mode (docs/AGENTIC_MODE.md): what the landing policy decides for this pull request now, its latest land operation, and Land
// for a writer the policy allows (a confirmation form with merge or squash). Shown only while agentic mode is on for the repository.
type Target = { repository: { owner: string; name: string }; repositoryId: string };
const message = (error: unknown) => error instanceof Error ? error.message : 'The landing could not be confirmed.';

export function PullLanding({ repository, repositoryId, userId, number, headCommitId, open, onLanded }: { repository: { owner: string; name: string }; repositoryId: string; userId: string; number: number;
  headCommitId: string; open: boolean; onLanded?: () => void }) {
  const target: Target = { repository: { owner: repository.owner, name: repository.name }, repositoryId };
  const runtime = useRuntimeCapabilities(), landingReady = settingAvailable(runtime.data, 'repository.agentic-landing');
  const state = useQuery({ ...privateQuery, queryKey: agenticKey(userId, repository.owner, repository.name), queryFn: ({ signal }) => readAgentic(target, signal), retry: false });
  const on = Boolean(state.data?.settings.enabled && state.data.feature.allowed);
  const landing = useQuery({ ...privateQuery, queryKey: [...agenticKey(userId, repository.owner, repository.name), 'landing', number, headCommitId], enabled: on && open, retry: false,
    queryFn: ({ signal }) => evaluateLanding(target, number, signal) });
  const lands = useQuery({ ...privateQuery, queryKey: [...landKey(userId, repository.owner, repository.name), 'pull', number], enabled: on && landingReady, retry: false,
    queryFn: ({ signal }) => listLands(target, { number, limit: 1 }, signal) });
  const [confirming, setConfirming] = useState(false), [notice, setNotice] = useState('');
  const latest = lands.data?.operations[0];
  if (!on || !open && !latest) return null;
  const value = landing.data?.evaluation, refresh = () => { void landing.refetch(); void lands.refetch(); };
  return <section className="metadata-details pull-landing" aria-label="Landing">
    <div className="browser-panel-heading"><h3>Landing</h3><button type="button" className="icon-button manual-refresh" aria-label="Refresh landing evaluation" title="Refresh landing evaluation" disabled={landing.isFetching || lands.isFetching} onClick={refresh}><RefreshCw size={16} className={landing.isFetching || lands.isFetching ? 'spin' : ''} /></button></div>
    {open ? landing.isError ? <p className="error" role="alert">{message(landing.error)}</p>
      : !value ? <p className="field-help" role="status">Evaluating…</p> : <>
        <p><strong className={`pull-landing-decision ${value.decision}`}>{decisionLabels[value.decision]}</strong> · <span>{riskLabels[value.risk]}</span></p>
        <ul className="pull-landing-reasons">{value.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        {value.matched.sensitive.length ? <><p className="field-help">Sensitive paths</p><ul className="pull-landing-paths">{value.matched.sensitive.map(path => <li key={path}><code>{path}</code></li>)}</ul></> : null}
        <p className="field-help">{landing.data!.changedPathCount} changed {landing.data!.changedPathCount === 1 ? 'path' : 'paths'}, opened by {landing.data!.origin === 'person' ? 'a person' : landing.data!.origin === 'agent-task' ? 'an agent task' : 'an API token'}. {state.data!.settings.landWithoutPerson ? 'Low-risk changes land on their own once their required checks pass.' : 'Golf lands a change only when a writer presses Land.'}</p>
      </> : null}
    {latest ? <div className="pull-landing-latest" aria-label="Latest landing">
      <p><strong className={`pull-landing-state ${latest.state.toLowerCase()}`}>{landStateLabels[latest.state]}</strong> · {latest.trigger === 'policy' ? 'by Golf (agentic mode)' : `by ${latest.actor || 'a person'}`} · <DateLabel value={latest.updatedAt} relative /></p>
      <p className="field-help">{landSummary(latest)}</p>
    </div> : lands.isError ? <p className="error" role="alert">{message(lands.error)}</p> : null}
    {notice ? <p className="session-notice" role="status">{notice}</p> : null}
    {open && landingReady && landing.data?.canLand && landing.data.headCommitId === headCommitId ? confirming
      ? <LandForm target={target} number={number} headCommitId={headCommitId} done={result => { setConfirming(false); if (result) { setNotice(result); refresh(); onLanded?.(); } }} />
      : <button type="button" className="button primary" onClick={() => { setNotice(''); setConfirming(true); }}>Land</button> : null}
  </section>;
}

// The confirmation: merge (a merge commit) or squash (one commit), for the exact head that was evaluated. One idempotency key per form.
function LandForm({ target, number, headCommitId, done }: { target: Target; number: number; headCommitId: string; done: (result: string) => void }) {
  const [error, setError] = useState<unknown>(), [key] = useState(() => crypto.randomUUID());
  const form = useForm({ defaultValues: { method: 'merge' as LandMethod }, onSubmit: async ({ value }) => {
    setError(undefined);
    try {
      const { operation } = await landPull(target, number, headCommitId, value.method, key);
      done(operation.state === 'LANDED' ? 'Landed.' : `${landStateLabels[operation.state]}: ${landSummary(operation) || 'see the latest landing.'}`);
    } catch (e) { setError(e); }
  } });
  return <form className="credential-form-content" aria-label="Land pull request" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="method">{field => <fieldset className="policy-choices"><legend>Land {headCommitId.slice(0, 12)} onto the current base</legend>
      <label className="policy-choice"><input type="radio" name="land-method" checked={field.state.value === 'merge'} onChange={() => field.handleChange('merge')} /><span><strong>Merge</strong><small>A merge commit keeps every commit of the branch.</small></span></label>
      <label className="policy-choice"><input type="radio" name="land-method" checked={field.state.value === 'squash'} onChange={() => field.handleChange('squash')} /><span><strong>Squash</strong><small>One commit with the pull request title.</small></span></label>
    </fieldset>}</form.Field>
    <p className="field-help">If the base branch moves meanwhile, Golf merges onto the new base and retries up to five times. Overlapping changes are not landed.</p>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={formState => formState.isSubmitting}>{submitting => <div className="credential-actions">
      <button className="button primary" disabled={submitting}>{submitting ? 'Landing…' : 'Land now'}</button><button type="button" className="button secondary" disabled={submitting} onClick={() => done('')}>Cancel</button></div>}</form.Subscribe>
  </form>;
}
