import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { ModelChip, shortModel } from './AiModelSettings';

// Mirrors repositoryView in cloudflare/forge/src/ai-models.mjs.
type RepositoryUse = { use: string; label: string; fixed?: boolean; model: string; source: 'fixed' | 'repository' | 'installation' | 'deploy' | 'unavailable'; note: string;
  overrideAllowed: boolean; default?: string; allowed: { model: string; description: string }[]; choice: string; version: string };
type RepositoryModels = { repositoryId: string; canEdit: boolean; allocated: boolean; uses: RepositoryUse[] };
const sources: Record<RepositoryUse['source'], string> = { fixed: 'Fixed', repository: 'This repository', installation: 'Installation default', deploy: 'Deploy default', unavailable: 'Unavailable' };

function ChoiceEditor({ use, context, onSaved, onCancel }: { use: RepositoryUse; context: { repository: { owner: string; name: string }; repositoryId: string }; onSaved: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const form = useForm({ defaultValues: { model: use.choice }, onSubmit: async ({ value }) => {
    setPending(true); setError('');
    try {
      await nativeAPI('/native/ai-models', { action: 'repository-update', ...context, use: use.use, model: value.model, expectedVersion: use.version });
      await onSaved(`${use.label}: ${value.model ? shortModel(value.model) : 'the installation default'}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Refresh before trying again.'); }
    finally { setPending(false); }
  } });
  return <form className="policy-editor" aria-label={`Choose the ${use.label} model`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="model">{field => <label>Model for this repository<select value={field.state.value} disabled={pending} onChange={event => field.handleChange(event.target.value)}>
      <option value="">Installation default ({shortModel(use.default || '')})</option>
      {use.allowed.map(option => <option key={option.model} value={option.model}>{shortModel(option.model)}</option>)}</select>
      <span className="field-help">Only models the installation allows are offered. If an administrator removes your choice later, the installation default applies.</span></label>}</form.Field>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending ? 'Saving…' : 'Save model'}</button><button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}

// Repository settings: the model each AI use runs here, and a choice among the allowed models only where the installation allows it.
export function RepositoryAiModels({ userId, owner, name, repositoryId, signingOut }: { userId: string; owner: string; name: string; repositoryId: string; signingOut: boolean }) {
  const context = { repository: { owner, name }, repositoryId };
  const query = useQuery({ ...privateQuery, queryKey: ['repository', userId, owner, name, 'ai-models'], enabled: !signingOut && Boolean(repositoryId), retry: false,
    queryFn: ({ signal }) => nativeAPI<RepositoryModels>('/native/ai-models/read', { action: 'repository', ...context }, signal) });
  const [editing, setEditing] = useState<string>(), [notice, setNotice] = useState('');
  const data = query.data;
  if (data && !data.allocated) return null;
  return <section className="browser-panel credential-list-panel" aria-labelledby="repository-ai-models-title">
    <div className="browser-panel-heading"><h2 id="repository-ai-models-title">AI models</h2></div>
    {notice ? <p className="policy-notice" role="status">{notice}</p> : null}
    {query.error ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !data ? <Loading label="Reading AI models…" /> : <>
      <ul className="policy-list">{data.uses.map(use => <li key={use.use} className="policy-row">
        <div className="policy-row-main"><div className="policy-row-title"><h4>{use.fixed ? <Lock size={13} aria-hidden="true" /> : null}{use.label}</h4>{use.model ? <ModelChip model={use.model} /> : null}<span className="policy-decider">{sources[use.source]}</span></div>
          <p className="policy-row-detail">{use.fixed ? 'Clef answers constrained choices with probabilities; it is fixed for every repository.' : use.overrideAllowed ? `This repository may choose among ${use.allowed.length} allowed models.` : 'The installation decides this model; repositories cannot choose it.'}{use.note ? ` ${use.note}` : ''}</p>
          {editing === use.use ? <ChoiceEditor key={use.version} use={use} context={context} onCancel={() => setEditing(undefined)} onSaved={async text => { setEditing(undefined); setNotice(text); await query.refetch(); }} /> : null}</div>
        {data.canEdit && use.overrideAllowed && editing !== use.use ? <button type="button" className="button secondary policy-edit" aria-label={`Choose the ${use.label} model`} disabled={Boolean(editing) || signingOut} onClick={() => { setEditing(use.use); setNotice(''); }}>Choose</button> : null}
      </li>)}</ul>
      <p className="panel-footnote">Installation administrators choose each default and the allowed models; you choose only where they allow it. Every AI result records the model it used.</p></>}
  </section>;
}
