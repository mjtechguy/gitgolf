import { useEffect, useRef, useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BarChart3, Bot, Lock, RefreshCw, Sparkles } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { SummaryBand } from './Layout';

// Mirrors cloudflare/forge/src/ai-models.mjs. The Worker re-validates every choice against the deploy list and the catalog.
export type ModelState = 'available' | 'unverified' | 'unsupported' | 'not-listed' | 'unread' | 'retired' | 'dimension';
export type ModelOption = { model: string; state: ModelState; reason: string; description: string; price: string; contextWindow: string; dimensions: number };
export type ModelChoice = { default: string; allowed: string[]; repositoryOverride: boolean };
export type AiUse = { use: string; label: string; detail: string; feature: string; task: string; fixed?: boolean; reason?: string; unavailable?: string; needs?: string; embedding?: boolean;
  value?: ModelChoice; deploy?: ModelChoice; source?: 'deploy' | 'installation'; version?: string; updatedAt?: string; updatedBy?: string; options?: ModelOption[];
  otherCatalogModels?: number; repositoriesOverriding?: number; notes?: string[]; confirmation?: string; reindex?: { known: boolean; repositories: number; chunks: number; calls: number } };
export type AiModelsView = { generatedAt: string; editing: { enabled: boolean; reason: string }; deploy: { source: 'deploy' | 'built-in'; valid: boolean }; allocated: boolean;
  catalog: { reads: { task: string; state: string; readAt: string; attemptedAt: string; models: number; reason: string }[]; stale: boolean; refreshable: boolean }; uses: AiUse[] };

export const stateLabels: Record<ModelState, [string, string]> = { available: ['Available', 'available'], unverified: ['Capability unverified', 'configured'], unsupported: ['Unsupported', 'refused'],
  'not-listed': ['Not in catalog', 'refused'], unread: ['Catalog not read', ''], retired: ['Retired', 'refused'], dimension: ['Needs a new index', 'configured'] };
export const shortModel = (model: string) => model.replace(/^@(?:cf|hf)\//, '');
export function ModelChip({ model, title }: { model: string; title?: string }) { return <span className="ai-model-chip" title={title || model}>{shortModel(model)}</span>; }

function widens(before: ModelChoice, after: ModelChoice) { return after.allowed.some(model => !before.allowed.includes(model)) || after.repositoryOverride && !before.repositoryOverride; }

function ModelEditor({ use, onSaved, onCancel }: { use: AiUse; onSaved: (text: string) => Promise<unknown>; onCancel: () => void }) {
  const value = use.value!, options = use.options || [], [error, setError] = useState(''), [pending, setPending] = useState(false), [operationId] = useState(() => crypto.randomUUID());
  // Models already allowed may stay while they are not retired; new ones must be available in the catalog.
  const offerable = (option: ModelOption) => option.state === 'available' || value.allowed.includes(option.model) && !['retired', 'not-listed', 'dimension'].includes(option.state);
  const form = useForm({ defaultValues: { default: value.default, allowed: [...value.allowed], repositoryOverride: value.repositoryOverride, confirmation: '' },
    onSubmit: async ({ value: draft }) => {
      setPending(true); setError('');
      const after = { default: draft.default, allowed: options.map(o => o.model).filter(model => draft.allowed.includes(model)), repositoryOverride: draft.repositoryOverride };
      try {
        // The same operation ID is reused for a retry of this edit, so it cannot apply twice.
        await nativeAPI('/native/ai-models', { action: 'update', use: use.use, expectedVersion: use.version, operationId, value: after, ...(widens(value, after) ? { confirmation: draft.confirmation } : {}) });
        await onSaved(`${use.label}: ${shortModel(after.default)} by default, ${after.allowed.length} allowed${after.repositoryOverride ? ', repositories may choose' : ''}.`);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Refresh before trying again.'); }
      finally { setPending(false); }
    } });
  const draft = useStore(form.store, state => state.values), after = { default: draft.default, allowed: draft.allowed, repositoryOverride: draft.repositoryOverride };
  const widening = widens(value, after), defaultOK = draft.allowed.includes(draft.default), changed = JSON.stringify([after.default, [...after.allowed].sort(), after.repositoryOverride]) !== JSON.stringify([value.default, [...value.allowed].sort(), value.repositoryOverride]);
  return <form className="policy-editor ai-model-editor" aria-label={`Edit ${use.label} models`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="default">{field => <label>Default model<select value={field.state.value} disabled={pending} onChange={event => field.handleChange(event.target.value)}>
      {options.map(option => <option key={option.model} value={option.model} disabled={!offerable(option) || !draft.allowed.includes(option.model)}>{shortModel(option.model)}{option.state === 'available' ? '' : ` — ${stateLabels[option.state][0].toLowerCase()}`}{draft.allowed.includes(option.model) ? '' : ' (not allowed)'}</option>)}
    </select><span className="field-help">New {use.label.toLowerCase()} runs use this model unless a repository chose another allowed one.</span></label>}</form.Field>
    <form.Field name="allowed">{field => <fieldset className="policy-choices ai-model-choices" disabled={pending}><legend>Allowed models <span className="optional">from this installation’s deploy list</span></legend>
      {options.map(option => <label key={option.model} className="policy-choice"><input type="checkbox" disabled={!offerable(option)} checked={field.state.value.includes(option.model)}
        onChange={event => field.handleChange(event.target.checked ? [...field.state.value, option.model] : field.state.value.filter(model => model !== option.model))} />
        <span><strong>{shortModel(option.model)} <span className={`visibility ${stateLabels[option.state][1]}`}>{stateLabels[option.state][0]}</span></strong>
          <small>{option.reason || option.description || option.model}{option.price ? ` · ${option.price}` : ''}{option.contextWindow ? ` · ${Number(option.contextWindow).toLocaleString()} tokens of context` : ''}{option.dimensions ? ` · ${option.dimensions} dimensions` : ''}</small></span></label>)}
    </fieldset>}</form.Field>
    <form.Field name="repositoryOverride">{field => <label className="checkbox-field"><input type="checkbox" disabled={pending} checked={field.state.value} onChange={event => field.handleChange(event.target.checked)} />Repository administrators may choose another allowed model</label>}</form.Field>
    {!defaultOK ? <p className="error" role="alert">The default must be one of the allowed models.</p> : null}
    <dl className="settings-profile settings-policy-effect">
      <div><dt>Queued and in-flight work</dt><dd>{use.use === 'agents' ? 'Proposals admitted with a model that changes are refused at their next step; the model is part of their policy identity.' : 'Runs admitted with a model that is no longer allowed are refused before inference; nothing is billed.'}</dd></div>
      <div><dt>New work</dt><dd>{use.embedding ? 'A new default re-indexes every repository with it; the current index keeps serving until each rebuild completes.' : 'New runs use the new default, or a repository’s choice while it stays allowed.'}</dd></div>
      <div><dt>Recorded runs</dt><dd>Keep the model they ran with.</dd></div></dl>
    {widening ? <form.Field name="confirmation">{field => <label className="policy-confirm">Type <code>{use.confirmation}</code> to widen these models<input autoComplete="off" spellCheck={false} disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
      <span className="field-help">Allowing another model or letting repositories choose also needs an Access sign-in from the last 10 minutes.</span></label>}</form.Field> : null}
    {error ? <p className="error" role="alert">{error}{/last 10 minutes/.test(error) ? <> <a href="/cdn-cgi/access/logout">Sign out of Access</a>, sign in again, then save.</> : null}</p> : null}
    <div className="credential-actions"><button type="submit" className="button primary" disabled={pending || !changed || !defaultOK || widening && draft.confirmation !== use.confirmation}>{pending ? 'Saving…' : `Save ${use.label.toLowerCase()} models`}</button>
      <button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}

function UseCard({ use, editable, editing, busy, onEdit, onCancel, onSaved }: { use: AiUse; editable: boolean; editing: boolean; busy: boolean; onEdit: () => void; onCancel: () => void; onSaved: (text: string) => Promise<unknown> }) {
  const value = use.value, source = use.fixed ? ['Fixed', ''] : use.source === 'installation' ? ['Set here', 'available'] : ['Deploy default', ''];
  return <section className="browser-panel settings-card ai-use-card" aria-labelledby={`ai-use-${use.use}`}>
    <div className="browser-panel-heading"><h3 id={`ai-use-${use.use}`}>{use.fixed ? <Lock size={14} aria-hidden="true" /> : use.use === 'agents' ? <Bot size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}{use.label}</h3>
      {use.unavailable ? <span className="visibility unallocated">Unavailable</span> : <span className={`visibility ${source[1]}`}>{source[0]}</span>}</div>
    <div className="settings-card-body">
      <p className="settings-card-service">{use.task}{use.needs ? ` · needs ${use.needs}` : ''}</p>
      {use.unavailable ? <p className="policy-row-detail">{use.unavailable}</p> : value ? <>
        <div className="ai-use-default"><span className="ai-use-label">Default</span><ModelChip model={value.default} /></div>
        <dl className="settings-profile">
          <div><dt>Allowed</dt><dd><span className="ai-chip-row">{value.allowed.map(model => <ModelChip key={model} model={model} />)}</span></dd></div>
          {use.fixed ? <div><dt>Why fixed</dt><dd>{use.reason}</dd></div> : <div><dt>Repositories</dt><dd>{value.repositoryOverride ? `May choose an allowed model${use.repositoriesOverriding ? ` · ${use.repositoriesOverriding} chose one` : ' · none has yet'}` : 'Use the default'}</dd></div>}
          {use.reindex ? <div><dt>Search index</dt><dd>{use.reindex.known ? use.reindex.chunks ? `Re-index required: ${use.reindex.chunks.toLocaleString()} chunks in ${use.reindex.repositories} repositories, about ${use.reindex.calls.toLocaleString()} calls` : 'Every index uses this model' : 'No semantic search index yet; the first index uses this model'}</dd></div> : null}
        </dl>
        {use.notes?.length ? <ul className="ai-use-notes">{use.notes.map(note => <li key={note} role="note">{note}</li>)}</ul> : null}
        <p className="policy-row-detail">{use.detail}</p>
      </> : null}
      {editing ? <ModelEditor key={use.version} use={use} onSaved={onSaved} onCancel={onCancel} /> : null}
    </div>
    <div className="ai-use-footer"><span>{use.fixed ? 'Clef only; not editable' : use.source === 'installation' ? <>Changed <DateLabel value={use.updatedAt || ''} relative /> by {use.updatedBy || 'an administrator'}</> : use.otherCatalogModels ? `${use.otherCatalogModels} other catalog models are not on the deploy list` : 'Deploy list in force'}</span>
      {editable && !use.fixed && !use.unavailable && !editing ? <button type="button" className="button secondary" aria-label={`Edit ${use.label} models`} disabled={busy} onClick={onEdit}>Edit</button> : null}</div>
  </section>;
}

type CatalogRow = ModelOption & { uses: string };
const catalogColumns: DataTableColumn<CatalogRow>[] = [
  { id: 'model', header: 'Model', accessorFn: row => row.model, cell: ({ row }) => <><strong className="ai-table-model">{shortModel(row.original.model)}</strong><small>{row.original.description || row.original.model}</small></> },
  { accessorKey: 'uses', header: 'Use cases' },
  { id: 'state', header: 'Catalog', accessorFn: row => stateLabels[row.state][0], cell: ({ row }) => <span className={`visibility ${stateLabels[row.original.state][1]}`}>{stateLabels[row.original.state][0]}</span> },
  { id: 'price', header: 'Price (catalog)', accessorFn: row => row.price || 'Not reported' },
  { id: 'context', header: 'Context', accessorFn: row => row.contextWindow ? Number(row.contextWindow).toLocaleString() : row.dimensions ? `${row.dimensions} dimensions` : '—' },
];

export function AiModelSettings({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const query = useQuery({ ...privateQuery, queryKey: ['ai-models', userId], enabled: !signingOut, retry: false,
    queryFn: ({ signal }) => nativeAPI<AiModelsView>('/native/ai-models/read', { action: 'installation' }, signal) });
  const [editing, setEditing] = useState<string>(), [notice, setNotice] = useState<{ text: string; failed: boolean }>(), opened = useRef(false);
  const refresh = useMutation({ mutationFn: (force: boolean) => nativeAPI<AiModelsView>('/native/ai-models', { action: 'refresh-catalog', force }),
    onSuccess: () => void query.refetch(), onError: error => setNotice({ text: `The catalog could not be refreshed: ${error.message}`, failed: true }) });
  const data = query.data;
  // Opening the page refreshes a catalog older than six hours, once.
  useEffect(() => { if (data?.catalog.stale && data.catalog.refreshable && data.editing.enabled && !opened.current) { opened.current = true; refresh.mutate(false); } }, [data, refresh]);
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  if (!data) return <Loading label="Reading AI models…" />;
  const configurable = data.uses.filter(use => !use.fixed && !use.unavailable), reads = data.catalog.reads.filter(read => read.readAt), latest = reads.map(read => read.readAt).sort().at(-1);
  const failed = data.catalog.reads.filter(read => read.state === 'failed'), warnings = data.uses.flatMap(use => (use.notes || []).map(note => `${use.label}: ${note}`));
  const rows = [...data.uses.flatMap(use => (use.options || []).map(option => ({ ...option, uses: use.label }))).reduce((map, row) => {
    const seen = map.get(row.model); map.set(row.model, seen ? { ...seen, uses: `${seen.uses}, ${row.uses}` } : row); return map; }, new Map<string, CatalogRow>()).values()];
  const saved = async (text: string) => { setEditing(undefined); setNotice({ text, failed: false }); await query.refetch(); };
  return <div className="page-stack">
    <div className="settings-toolbar"><p className="field-help">{data.editing.reason}</p>
      <button type="button" className="button secondary" disabled={refresh.isPending || !data.catalog.refreshable || !data.editing.enabled} onClick={() => { setNotice(undefined); refresh.mutate(true); }}><RefreshCw size={15} className={refresh.isPending ? 'spin' : undefined} />{refresh.isPending ? 'Reading catalog…' : 'Refresh catalog'}</button>
      <Link className="button secondary" to="/admin/ai-usage"><BarChart3 size={15} />AI usage</Link></div>
    <p className="field-help">These are the Cloudflare model defaults. Summaries, review drafts and release notes can instead run an engine chosen in <Link to="/admin/engines">Engines</Link> (a Workers AI model or a provider model with a vault key); where none is chosen, the model here applies. Agent proposals, triage, advice and search keep these settings.</p>
    <SummaryBand label="AI model summary" items={[
      ['Use cases', `${configurable.length} configurable`, `${data.uses.filter(use => use.fixed).length} fixed to Clef`],
      ['Set by an administrator', String(configurable.filter(use => use.source === 'installation').length), 'Others use the deploy default'],
      ['Repositories may choose', String(configurable.filter(use => use.value?.repositoryOverride).length), `${configurable.reduce((sum, use) => sum + (use.repositoriesOverriding || 0), 0)} repository choices in force`],
      ['Catalog', latest ? <DateLabel key="catalog" value={latest} relative /> : 'Not read yet', failed.length ? `${failed.length} task read failed` : `${reads.reduce((sum, read) => sum + read.models, 0)} models listed`],
      ['Deploy list', data.deploy.valid ? data.deploy.source === 'deploy' ? 'As deployed' : 'Built-in' : 'Invalid', data.deploy.valid ? 'The ceiling for every choice' : 'Nothing is allowed until redeployed'],
    ]} />
    {!data.allocated ? <p className="error" role="alert">Workers AI is not allocated on this installation; these choices take effect once it is (enable-ai).</p> : null}
    {failed.length ? <p className="error" role="alert">{failed.map(read => `${read.task} catalog: ${read.reason}`).join(' ')} {reads.length ? 'Earlier catalog reads are shown.' : 'Nothing can be verified until a read succeeds.'}</p> : null}
    {warnings.length ? <section className="browser-panel ai-warning-band" aria-label="Model warnings"><ul className="settings-attention-list">{warnings.map(text => <li key={text}>{text}</li>)}</ul></section> : null}
    {notice ? <p className={notice.failed ? 'error' : 'policy-notice'} role={notice.failed ? 'alert' : 'status'}>{notice.text}</p> : null}
    <div className="settings-card-grid ai-use-grid">{data.uses.map(use => <UseCard key={use.use} use={use} editable={data.editing.enabled} editing={editing === use.use} busy={Boolean(editing) || signingOut || refresh.isPending}
      onEdit={() => { setEditing(use.use); setNotice(undefined); }} onCancel={() => setEditing(undefined)} onSaved={saved} />)}</div>
    <section className="browser-panel" aria-labelledby="ai-catalog-title"><div className="browser-panel-heading"><h2 id="ai-catalog-title">Deploy list and catalog</h2><span className="policy-card-note">Models the deploy allows, as this account’s Workers AI catalog reports them</span></div>
      <DataTable data={rows} columns={catalogColumns} getRowId={row => row.model} label="Deploy-listed models" emptyMessage="This deploy lists no configurable models." pagination={false} /></section>
    <p className="panel-footnote">Only models on the deploy list (<code>ai_models</code> in <code>forge.json</code>) that the account catalog lists for the right task, with the capability the use needs, can be allowed. Adding a model to the deploy list needs a deploy. Prices appear only when the catalog reports them; Cloudflare billing is authoritative. Every AI run and agent proposal records the model it used.</p>
  </div>;
}
