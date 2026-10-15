import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, RefreshCw } from 'lucide-react';
import { nativeAPI as api } from './nativeAPI';
import { Loading, privateQuery } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';
import { credentialMessage as message, kindLabels, placeLabels, providerLabel, sourceLabels, targetBody, type Engine, type EngineInventory, type EngineTarget, type EngineUse, type Place } from './vault';

// Engines (docs/ENGINES.md): which engine each AI use case runs, chosen at installation, organization and repository level, and the engines
// a scope defines. Engine selection replaces per-use-case model selection; with no choice, the Workers AI model from AI models applies.
const intro: Record<EngineTarget['scope'], string> = {
  installation: 'Choose the engine each AI use case runs on every repository, and whether organizations may choose their own. With no choice, the Workers AI model chosen in AI models applies, as before.',
  organization: 'Choose the engine each AI use case runs in this organization’s repositories, where the installation lets organizations choose, and whether repositories may choose.',
  repository: 'The engine each AI use case runs in this repository. Repository administrators choose only where the installation and organization allow it.',
  user: 'Your personal engines: provider models with your own API keys, or coding CLIs with your sign-ins, for automations you run. Only you can use them.',
};
const modelText = (engine: Engine) => engine.kind === 'coding-cli' ? `${engine.tool}${engine.model ? ' · ' + engine.model : ''}` : engine.kind === 'provider-model' ? `${providerLabel(engine.provider)} · ${engine.model}` : engine.model;
const engineName = (data: EngineInventory, id: string) => !id ? '' : [...data.selectable, ...data.engines].find(engine => engine.id === id)?.name || id;

export function EngineSettings({ target, userId }: { target: EngineTarget; userId: string }) {
  const body = targetBody(target);
  const inventory = useQuery({ ...privateQuery, queryKey: ['native-engines', userId, JSON.stringify(body)], queryFn: ({ signal }) => api<EngineInventory>('/native/engines', { ...body, action: 'list' }, signal) });
  const [creating, setCreating] = useState(false), [editing, setEditing] = useState<Engine>(), [choosing, setChoosing] = useState<EngineUse>();
  const [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const data = inventory.data;
  const reset = () => { setCreating(false); setEditing(undefined); setChoosing(undefined); setNotice(''); setError(undefined); };
  const saved = async (text: string) => { reset(); setNotice(text); await inventory.refetch(); };
  const remove = async (engine: Engine) => {
    if (!window.confirm(`Delete engine ${engine.name}? Automations that name it stop using it.`)) return;
    setBusy(true); setError(undefined); setNotice('');
    try { await api('/native/engines', { action: 'delete', id: engine.id }); setNotice(`${engine.name} was deleted.`); await inventory.refetch(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const useColumns: DataTableColumn<EngineUse>[] = [
    { accessorKey: 'label', header: 'AI use', cell: ({ row: { original: u } }) => <div><strong>{u.label}</strong>{u.detail ? <small className="muted"> {u.detail}</small> : null}</div> },
    { id: 'effective', header: 'Engine in effect', accessorFn: u => u.effective?.engineName || u.reason || '', cell: ({ row: { original: u } }) => !u.selectable ? <span className="muted">{u.reason}</span>
      : u.effective?.refusal ? <span className="error">{u.effective.refusal}</span> : <div><strong>{u.effective?.engineName}</strong> <code>{u.effective?.model}</code><small className="muted"> · {sourceLabels[u.effective?.source || ''] || u.effective?.source}</small>{u.effective?.note ? <small className="muted"> {u.effective.note}</small> : null}</div> },
    { id: 'choice', header: 'Choice here', accessorFn: u => data && u.selection ? engineName(data, u.selection.engineId) : '', cell: ({ row: { original: u } }) => !u.selectable ? <span className="muted">Not selectable</span>
      : !u.allowedHere ? <span className="muted">{u.reason}</span> : u.selection?.engineId && data ? engineName(data, u.selection.engineId) : <span className="muted">{target.scope === 'installation' ? 'Default (AI models)' : 'Follow the level above'}</span> },
    ...(target.scope === 'repository' ? [] : [{ id: 'override', header: target.scope === 'installation' ? 'Organizations may choose' : 'Repositories may choose', accessorFn: (u: EngineUse) => u.selection?.allowOverride ? 'Yes' : 'No' } as DataTableColumn<EngineUse>]),
    ...(data?.canSelect ? [{ id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: u } }) => u.selectable && u.allowedHere
      ? <button className="button secondary" disabled={busy} aria-label={`Choose the engine for ${u.label}`} onClick={() => { reset(); setChoosing(u); }}>Edit</button> : null } as DataTableColumn<EngineUse>] : []),
  ];
  const engineColumns: DataTableColumn<Engine>[] = [
    { accessorKey: 'name', header: 'Engine', cell: ({ row: { original: e } }) => <div><strong>{e.name}</strong><small className="muted"> · {kindLabels[e.kind]}</small></div> },
    { id: 'model', header: 'Model or tool', accessorFn: modelText, cell: ({ row: { original: e } }) => <code>{modelText(e)}</code> },
    { id: 'credential', header: 'Credential', accessorFn: e => e.credential?.label || '', cell: ({ row: { original: e } }) => e.credential ? <span>{e.credential.label}{e.credential.state !== 'active' ? <small className="error"> ({e.credential.state})</small> : null}</span> : <span className="muted">None needed</span> },
    { id: 'places', header: 'Places', accessorFn: e => e.places.map(place => placeLabels[place]).join(', ') },
    { id: 'state', header: 'State', accessorFn: e => e.enabled ? 'Enabled' : 'Disabled', cell: ({ row: { original: e } }) => <span className={`visibility${e.enabled ? ' available' : ''}`}>{e.enabled ? 'Enabled' : 'Disabled'}</span> },
    ...(data?.canManage ? [{ id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: e } }) => <div className="row-actions">
      <button className="button secondary" disabled={busy} aria-label={`Edit ${e.name}`} onClick={() => { reset(); setEditing(e); }}>Edit</button>
      <button className="button secondary danger-action" disabled={busy} aria-label={`Delete ${e.name}`} onClick={() => void remove(e)}>Delete</button></div> } as DataTableColumn<Engine>] : []),
  ];
  return <div className="page-stack">
    {inventory.isError ? <section className="browser-panel"><p className="error" role="alert">{message(inventory.error)}</p></section> : !data ? <section className="browser-panel"><Loading label="Reading engines…" /></section> : <>
      {target.scope !== 'user' ? <section className="browser-panel" aria-labelledby="engine-uses-title"><div className="browser-panel-heading"><h2 id="engine-uses-title">Engine for each AI use</h2>
        <button className="button secondary" aria-label="Refresh engines" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}><RefreshCw size={15} className={inventory.isFetching ? 'spin' : ''} />Refresh</button></div>
        <p className="field-help">{intro[target.scope]}</p>
        {notice ? <p className="field-help" role="status">{notice}</p> : null}
        {error ? <p className="error" role="alert">{message(error)}</p> : null}
        <DataTable data={data.uses} columns={useColumns} getRowId={u => u.use} label="AI uses" pagination={false} />
        {target.scope === 'installation' ? <p className="panel-footnote">The Workers AI defaults, the allowed models and repository model choices stay in <Link to="/admin/ai">AI models</Link>; an engine chosen here takes precedence for its use.</p> : null}
        {!data.gateway ? <p className="panel-footnote">Provider models are unavailable on this installation: they need approved AI and the private AI Gateway.</p> : null}
      </section> : null}
      {choosing ? <ChooseEngine key={choosing.use} target={target} use={choosing} data={data} close={() => setChoosing(undefined)} done={saved} /> : null}
      {target.scope !== 'repository' ? <section className="browser-panel" aria-labelledby="engines-title"><div className="browser-panel-heading"><h2 id="engines-title">{target.scope === 'user' ? 'Your engines' : 'Engines'}</h2>
        {data.canManage ? <button className="button primary" aria-expanded={creating} onClick={() => { reset(); setCreating(true); }}><Plus size={15} />New engine</button> : null}</div>
        {target.scope === 'user' ? <p className="field-help">{intro.user}</p> : <p className="field-help">Engines defined here, beside the built-in Workers AI models on the deploy list ({data.workersAiModels.join(', ') || 'none'}). Provider models use an API key from this scope’s credentials.</p>}
        {target.scope === 'user' && notice ? <p className="field-help" role="status">{notice}</p> : null}
        {target.scope === 'user' && error ? <p className="error" role="alert">{message(error)}</p> : null}
        <DataTable data={data.engines} columns={engineColumns} getRowId={e => e.id} label="engines" emptyMessage={data.canManage ? 'No engines here yet. Choose New engine to add one.' : 'No engines here.'} />
      </section> : null}
      {creating || editing ? <EngineForm key={editing?.id || 'new'} target={target} engine={editing} data={data} close={() => { setCreating(false); setEditing(undefined); }} done={saved} /> : null}
    </>}
  </div>;
}

function ChooseEngine({ target, use, data, close, done }: { target: EngineTarget; use: EngineUse; data: EngineInventory; close: () => void; done: (text: string) => Promise<void> }) {
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { engineId: use.selection?.engineId || '', allowOverride: Boolean(use.selection?.allowOverride) }, onSubmit: async ({ value }) => {
    setError(undefined);
    try {
      await api('/native/engines', { ...targetBody(target), action: 'select', use: use.use, engineId: value.engineId, allowOverride: target.scope === 'repository' ? false : value.allowOverride, expectedVersion: use.selection?.version || 0 });
      await done(`${use.label}: ${value.engineId ? engineName(data, value.engineId) : target.scope === 'installation' ? 'the AI models default' : 'following the level above'}.`);
    } catch (e) { setError(e); }
  } });
  return <form className="browser-panel credential-form-content" aria-label={`Choose the engine for ${use.label}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Engine for {use.label.toLowerCase()}</h3>
    <form.Field name="engineId">{field => <label>Engine<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>
      <option value="">{target.scope === 'installation' ? 'Default: the Workers AI model in AI models' : 'Follow the level above'}</option>
      {data.selectable.map(engine => <option key={engine.id} value={engine.id}>{engine.name} ({kindLabels[engine.kind]}{engine.kind === 'provider-model' ? ', ' + providerLabel(engine.provider) : ''})</option>)}</select>
      <span className="field-help">Provider models run with the API key their engine names; each person who starts a run must be allowed to use that key, or the run is refused.</span></label>}</form.Field>
    {target.scope !== 'repository' ? <form.Field name="allowOverride">{field => <label className="policy-choice"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} />
      <span><strong>{target.scope === 'installation' ? 'Organizations and their repositories may choose their own engine' : 'Repositories in this organization may choose their own engine'}</strong><small>Withdrawing this later makes their choices stop counting at once.</small></span></label>}</form.Field> : null}
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}>Save engine</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function EngineForm({ target, engine, data, close, done }: { target: EngineTarget; engine?: Engine; data: EngineInventory; close: () => void; done: (text: string) => Promise<void> }) {
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { name: engine?.name || '', kind: engine?.kind || (data.gateway ? 'provider-model' : 'cloudflare-model') as Engine['kind'], provider: engine?.provider && engine.provider !== 'workers-ai' ? engine.provider : 'anthropic',
    model: engine?.model || '', tool: engine?.tool || 'codex', credentialId: engine?.credential?.id || '', places: (engine?.places || []) as Place[], enabled: engine?.enabled ?? true },
  onSubmit: async ({ value }) => {
    setError(undefined);
    const places = value.kind === 'coding-cli' ? value.places : ['cloud'];
    try {
      if (engine) await api('/native/engines', { action: 'update', id: engine.id, expectedVersion: engine.version, name: value.name.trim(), model: value.model.trim(), credentialId: value.credentialId, places, enabled: value.enabled });
      else await api('/native/engines', { ...targetBody(target), action: 'create', name: value.name.trim(), kind: value.kind, ...(value.kind === 'provider-model' ? { provider: value.provider } : {}), ...(value.kind === 'coding-cli' ? { tool: value.tool } : {}),
        model: value.model.trim(), credentialId: value.credentialId, places, enabled: value.enabled });
      await done(`${value.name.trim()} was ${engine ? 'saved' : 'added'}.`);
    } catch (e) { setError(e); }
  } });
  return <form className="browser-panel credential-form-content" aria-label={engine ? `Edit ${engine.name}` : 'New engine'} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>{engine ? `Edit ${engine.name}` : 'New engine'}</h3>
    <form.Field name="name">{field => <label>Name<input required maxLength={80} value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="Claude for reviews" autoComplete="off" /></label>}</form.Field>
    <form.Field name="kind">{field => <label>Kind<select value={field.state.value} disabled={Boolean(engine)} onChange={e => { field.handleChange(e.target.value as Engine['kind']); form.setFieldValue('model', ''); form.setFieldValue('credentialId', ''); }}>
      {data.kinds.filter(kind => target.scope !== 'user' || kind !== 'cloudflare-model').map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label>}</form.Field>
    <form.Subscribe selector={state => [state.values.kind, state.values.provider, state.values.tool] as const}>{([kind, provider, tool]) => <>
      {kind === 'provider-model' ? <form.Field name="provider">{field => <label>Provider<select value={field.state.value} disabled={Boolean(engine)} onChange={e => { field.handleChange(e.target.value); form.setFieldValue('credentialId', ''); }}>{data.providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}</form.Field> : null}
      {kind === 'coding-cli' ? <form.Field name="tool">{field => <label>Coding CLI<select value={field.state.value} disabled={Boolean(engine)} onChange={e => field.handleChange(e.target.value)}>{data.tools.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>}</form.Field> : null}
      <form.Field name="model">{field => kind === 'cloudflare-model' ? <label>Workers AI model<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}><option value="">Choose a model</option>{data.workersAiModels.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
        : <label>{kind === 'coding-cli' ? 'Model (optional)' : 'Model'}<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder={kind === 'coding-cli' ? 'The tool’s default' : provider === 'anthropic' ? 'claude-sonnet-4-5' : provider === 'openai' ? 'gpt-5' : provider === 'xai' ? 'grok-4' : 'gemini-2.5-pro'} autoComplete="off" spellCheck={false} /></label>}</form.Field>
      {kind !== 'cloudflare-model' ? <form.Field name="credentialId">{field => { const options = data.credentials.filter(c => kind === 'provider-model' ? c.kind === 'api-key' && c.provider === provider : c.kind === 'api-key' || c.tool === tool);
        return <label>Credential<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}><option value="">{kind === 'provider-model' ? 'Choose an API key' : 'None: the sign-in already on the host'}</option>{options.map(c => <option key={c.id} value={c.id}>{c.label} ({c.kind === 'api-key' ? 'API key ' + c.fingerprint : 'sign-in'})</option>)}</select>
          {kind === 'provider-model' && !options.length ? <span className="field-help">Add a {providerLabel(provider)} API key under Credentials in this scope first.</span> : null}</label>; }}</form.Field> : null}
      {kind === 'coding-cli' ? <form.Field name="places">{field => <fieldset className="policy-choices"><legend>Where it runs</legend>{data.places.map(place => <label key={place} className="policy-choice"><input type="checkbox" checked={field.state.value.includes(place)} onChange={e => field.handleChange(e.target.checked ? [...field.state.value, place] : field.state.value.filter(item => item !== place))} /><span><strong>{placeLabels[place]}</strong>{place === 'cloud' ? <small>Cloud sandboxes are not available yet.</small> : null}</span></label>)}</fieldset>}</form.Field> : null}
    </>}</form.Subscribe>
    <form.Field name="enabled">{field => <label className="policy-choice"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} /><span><strong>Enabled</strong><small>A disabled engine stops being used; selections fall back to the default.</small></span></label>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, !state.values.name.trim() || state.values.kind !== 'coding-cli' && !state.values.model || state.values.kind === 'provider-model' && !state.values.credentialId || state.values.kind === 'coding-cli' && !state.values.places.length] as const}>{([submitting, incomplete]) =>
      <div className="credential-actions"><button className="button primary" disabled={submitting || incomplete}>{engine ? 'Save engine' : 'Add engine'}</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}
