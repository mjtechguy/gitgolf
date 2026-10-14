import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { repositoryClient } from './api';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { agenticKey, readAgentic, saveAgentic, type AgenticSettings, type AgenticState } from './agenticMode';

// Agentic mode (docs/AGENTIC_MODE.md): one repository setting, shown as its current values first; Edit opens the form.
const message = (error: unknown) => error instanceof Error ? error.message : 'The agentic mode change could not be confirmed.';
const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
const onOff = (value: boolean) => value ? 'On' : 'Off';
type Rule = { pattern: string; kind: 'Low-risk' | 'Sensitive' };
const ruleMeaning: Record<Rule['kind'], string> = { 'Low-risk': 'A change touching only low-risk paths may land without a person when that is on.', Sensitive: 'Always needs approval from a writer who is not the author and not an agent.' };

export function AgenticModeSettings({ userId, owner, name }: { userId: string; owner: string; name: string }) {
  const repository = useQuery({ ...privateQuery, queryKey: [...agenticKey(userId, owner, name), 'repository'], queryFn: async ({ signal }) => {
    const response = await repositoryClient.getRepository({ repository: { owner, name } }, { signal, timeoutMs: 8000 });
    if (!response.repository?.id) throw new Error('The repository could not be read.');
    return response.repository.id;
  } });
  const target = repository.data ? { repository: { owner, name }, repositoryId: repository.data } : undefined;
  const state = useQuery({ ...privateQuery, queryKey: agenticKey(userId, owner, name), enabled: Boolean(target), queryFn: ({ signal }) => readAgentic(target!, signal) });
  const [editing, setEditing] = useState(false), [notice, setNotice] = useState('');
  const data = state.data, settings = data?.settings;
  const rules: Rule[] = settings ? [...settings.lowRiskPaths.map(pattern => ({ pattern, kind: 'Low-risk' as const })), ...settings.sensitivePaths.map(pattern => ({ pattern, kind: 'Sensitive' as const }))] : [];
  const columns: DataTableColumn<Rule>[] = [
    { accessorKey: 'pattern', header: 'Path pattern', cell: ({ row: { original: rule } }) => <code>{rule.pattern}</code> },
    { accessorKey: 'kind', header: 'Kind', cell: ({ row: { original: rule } }) => <span className={`visibility${rule.kind === 'Low-risk' ? ' available' : ''}`}>{rule.kind}</span> },
    { id: 'meaning', header: 'Meaning', enableSorting: false, enableGlobalFilter: false, accessorFn: rule => ruleMeaning[rule.kind] },
  ];
  const error = repository.error || state.error;
  return <section className="page-stack" aria-labelledby="agentic-mode-title">
    <header className="repository-intro"><div><h1 id="agentic-mode-title">Agentic mode</h1><p>How changes from coding agents and people land in this repository: which paths are low-risk, which are sensitive, which checks must pass and whether low-risk changes may land without a person.</p></div></header>
    <section className="browser-panel credential-list-panel" aria-labelledby="agentic-current-title"><div className="browser-panel-heading"><h2 id="agentic-current-title">Current setting</h2>
      <div className="credential-actions">{data?.canEdit && !editing ? <button className="button secondary" onClick={() => { setNotice(''); setEditing(true); }}>Edit agentic mode</button> : null}
        <button className="button secondary" aria-label="Refresh agentic mode" disabled={state.isFetching || editing} onClick={() => void state.refetch()}><RefreshCw size={15} className={state.isFetching ? 'spin' : ''} />Refresh</button></div></div>
      {error ? <PanelError error={error} retry={() => void (repository.error ? repository.refetch() : state.refetch())} /> : !data || !settings ? <Loading label="Reading agentic mode…" /> : <>
        {!data.feature.allowed ? <p className="field-help" role="note">{data.feature.reason} The saved setting is kept and applies again when the policy allows agentic mode.</p> : null}
        {notice ? <p className="session-notice" role="status">{notice}</p> : null}
        {editing ? <AgenticModeEditor state={data} target={target!} done={saved => { setEditing(false); setNotice(saved ? 'Agentic mode saved.' : ''); void state.refetch(); }} /> :
          <div className="credential-form-content"><dl className="settings-profile">
            <div><dt>Agentic mode</dt><dd>{onOff(settings.enabled && data.feature.allowed)}{settings.enabled && !data.feature.allowed ? ' (turned on here, off by policy)' : ''}</dd></div>
            <div><dt>Land without a person</dt><dd>{onOff(settings.landWithoutPerson)}{settings.landWithoutPerson ? ' — changes that touch only low-risk paths and pass every required check need no reviewer.' : ' — every change needs approval from a writer.'}</dd></div>
            <div><dt>Required checks</dt><dd>{settings.requiredChecks.length ? settings.requiredChecks.map((check, index) => <span key={check}>{index ? ', ' : ''}<code>{check}</code></span>) : 'Every pipeline that runs on the head commit'}</dd></div>
            <div><dt>Revert on failure</dt><dd>{onOff(settings.revertOnFailure)} — stored for automatic reverts of landed changes, which Golf does not perform yet.</dd></div>
            <div><dt>Last changed</dt><dd>{settings.version ? <>{settings.updatedBy || 'Unknown account'}, <DateLabel value={settings.updatedAt} relative /></> : 'Never: these are the defaults'}</dd></div>
          </dl>
          <p className="field-help">Golf shows on each open pull request what this policy would decide. It does not land pull requests on its own yet.</p></div>}
      </>}
    </section>
    {settings && !editing ? <section className="browser-panel" aria-labelledby="agentic-paths-title"><div className="browser-panel-heading"><h2 id="agentic-paths-title">Path rules</h2></div>
      <p className="field-help">Patterns match whole paths from the repository root: <code>*</code> and <code>?</code> stay within one folder, <code>**</code> spans any number of folders. Sensitive wins over low-risk. All {rules.length} rules are listed; search and sorting cover this list.</p>
      <DataTable data={rules} columns={columns} getRowId={rule => rule.kind + ':' + rule.pattern} label="Agentic mode path rules" emptyMessage="No path rules. Every change needs a person." pagination={false} />
    </section> : null}
  </section>;
}

function AgenticModeEditor({ state, target, done }: { state: AgenticState; target: { repository: { owner: string; name: string }; repositoryId: string }; done: (saved: boolean) => void }) {
  const [error, setError] = useState<unknown>(), settings = state.settings, limits = state.limits;
  const form = useForm({ defaultValues: { enabled: settings.enabled, lowRiskPaths: settings.lowRiskPaths.join('\n'), sensitivePaths: settings.sensitivePaths.join('\n'), landWithoutPerson: settings.landWithoutPerson,
    requiredChecks: settings.requiredChecks.join('\n'), revertOnFailure: settings.revertOnFailure },
  onSubmit: async ({ value }) => {
    setError(undefined);
    const next: Omit<AgenticSettings, 'version' | 'updatedBy' | 'updatedAt'> = { enabled: value.enabled, lowRiskPaths: lines(value.lowRiskPaths), sensitivePaths: lines(value.sensitivePaths), landWithoutPerson: value.landWithoutPerson,
      requiredChecks: lines(value.requiredChecks), revertOnFailure: value.revertOnFailure };
    try { await saveAgentic(target, settings.version, next); done(true); } catch (e) { setError(e); }
  } });
  const count = (text: string, max: number, what: string) => lines(text).length > max ? `List at most ${max} ${what}.` : undefined;
  return <form className="credential-form-content" aria-label="Edit agentic mode" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="enabled">{field => <label className="policy-choice"><input type="checkbox" checked={field.state.value} disabled={!state.feature.allowed && !field.state.value} onChange={e => field.handleChange(e.target.checked)} />
      <span><strong>Agentic mode</strong><small>{state.feature.allowed ? 'Evaluate pull requests against this policy.' : state.feature.reason}</small></span></label>}</form.Field>
    <form.Field name="lowRiskPaths" validators={{ onChange: ({ value }) => count(value, limits.patterns, 'low-risk paths') }}>{field => <><label>Low-risk paths<textarea rows={4} value={field.state.value} onChange={e => field.handleChange(e.target.value)} spellCheck={false} placeholder={'docs/**\n**/*.md'} /></label>
      <p className="field-help">One pattern per line, up to {limits.patterns}, each up to {limits.patternLength} characters. For example <code>docs/**</code>, <code>**/*.md</code> or <code>**/*_test.go</code>.</p>
      {field.state.meta.errors.length ? <p className="error" role="alert">{field.state.meta.errors.join(' ')}</p> : null}</>}</form.Field>
    <form.Field name="sensitivePaths" validators={{ onChange: ({ value }) => count(value, limits.patterns, 'sensitive paths') }}>{field => <><label>Sensitive paths<textarea rows={5} value={field.state.value} onChange={e => field.handleChange(e.target.value)} spellCheck={false} placeholder={'.github/**\ndeploy/**'} /></label>
      <p className="field-help">Changes touching these always need approval from a writer who is not the author and not an agent, whatever else is set.</p>
      {field.state.meta.errors.length ? <p className="error" role="alert">{field.state.meta.errors.join(' ')}</p> : null}</>}</form.Field>
    <form.Field name="landWithoutPerson">{field => <><label className="policy-choice"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} />
      <span><strong>Land without a person</strong><small>Low-risk changes that pass every required check need no reviewer.</small></span></label>
      {field.state.value ? <p className="field-help check-warning" role="note">Warning: with this on, a change whose paths all match the low-risk patterns needs no review once its required checks pass. Keep the low-risk patterns narrow; a broad pattern such as <code>**</code> lets any change through.</p> : null}</>}</form.Field>
    <form.Field name="requiredChecks" validators={{ onChange: ({ value }) => count(value, limits.checks, 'required checks') }}>{field => <><label>Required checks<textarea rows={3} value={field.state.value} onChange={e => field.handleChange(e.target.value)} spellCheck={false} placeholder="Leave empty for every pipeline on the head commit" /></label>
      <p className="field-help">One check name per line: a workflow name, <code>workflow / job</code>, or a reported check context. Empty means every pipeline that runs on the head commit must pass.</p>
      {field.state.meta.errors.length ? <p className="error" role="alert">{field.state.meta.errors.join(' ')}</p> : null}</>}</form.Field>
    <form.Field name="revertOnFailure">{field => <label className="policy-choice"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} />
      <span><strong>Revert on failure</strong><small>Stored now; automatic reverts of landed changes are not available yet.</small></span></label>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={formState => [formState.isSubmitting, formState.canSubmit] as const}>{([submitting, canSubmit]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || !canSubmit}>{submitting ? 'Saving…' : 'Save agentic mode'}</button><button type="button" className="button secondary" disabled={submitting} onClick={() => done(false)}>Cancel</button></div>}</form.Subscribe>
  </form>;
}
