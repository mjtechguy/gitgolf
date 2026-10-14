import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { nativeAPI as api } from './nativeAPI';
import { CopyButton, DateLabel, Loading, privateQuery } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';

type Scope = { scope: 'installation' } | { scope: 'organization'; organization: string } | { scope: 'repository'; repository: { owner: string; name: string }; repositoryId: string };
type Runner = { id: string; uuid: string; engine: string; scope: string; scopeId: string; name: string; labels: string[]; state: 'ACTIVE' | 'DISABLED'; version: string; ephemeral: boolean; createdAt: string; lastSeenAt: string | null; online: boolean; busy: boolean };
type Token = { id: string; engine: string; labels: string[]; expiresAt: string; usesLeft: number; createdAt: string };
type Inventory = { scope: string; runners: Runner[]; inherited: Runner[]; tokens: Token[]; engines: string[]; forgejoRunner: { version: string; sha256: string }; instance: string };
const engineLabels: Record<string, string> = { 'forgejo-actions': 'Forgejo Runner (GitHub Actions)', 'gitlab-ci': 'GitLab Runner (GitLab CI)' };
const scopeLabel = (scope: string) => scope === 'installation' ? 'Installation' : scope === 'organization' ? 'Organization' : 'Repository';
const message = (error: unknown) => error instanceof Error ? error.message : 'The runner operation could not be confirmed.';
const labelName = (label: string) => label.split(':')[0];
const status = (runner: Runner) => runner.state === 'DISABLED' ? 'Disabled' : !runner.online ? 'Offline' : runner.busy ? 'Active' : 'Idle';

export function NativePipelineRunners({ target, userId }: { target: Scope; userId: string }) {
  const config = useQuery({ ...privateQuery, queryKey: ['native-config', userId], queryFn: ({ signal }) => api<{ pipelines?: boolean }>('/native/config', {}, signal) });
  const key = ['native-pipeline-runners', userId, JSON.stringify(target)];
  const inventory = useQuery({ ...privateQuery, queryKey: key, enabled: config.data?.pipelines === true, queryFn: ({ signal }) => api<Inventory>('/native/pipeline-runners', { ...target, action: 'list' }, signal), refetchInterval: 15000 });
  const [creating, setCreating] = useState(false), [editing, setEditing] = useState<Runner>(), [created, setCreated] = useState<{ token: string; commands: string[]; engine: string }>();
  const [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  const act = async (body: object) => { setBusy(true); setError(undefined); try { await api('/native/pipeline-runners', { ...target, ...body }); await inventory.refetch(); } catch (e) { setError(e); } finally { setBusy(false); } };
  if (config.isSuccess && !config.data.pipelines) return null;
  const columns = (own: boolean): DataTableColumn<Runner>[] => [
    { accessorKey: 'name', header: 'Runner', cell: ({ row: { original: r } }) => <div><strong>{r.name}</strong><div className="field-help">{engineLabels[r.engine] || r.engine}{r.version ? ` · ${r.version}` : ''}{r.ephemeral ? ' · ephemeral' : ''}</div></div> },
    { id: 'labels', header: 'Labels', accessorFn: r => r.labels.map(labelName).join(' '), cell: ({ row }) => <span className="pipeline-labels">{row.original.labels.map(label => <span key={label} title={label}>{labelName(label)}</span>)}</span> },
    { id: 'status', header: 'Status', accessorFn: status },
    { id: 'seen', header: 'Last seen', accessorFn: r => r.lastSeenAt || '', cell: ({ row }) => row.original.lastSeenAt ? <DateLabel value={row.original.lastSeenAt} relative /> : 'Never' },
    ...(own ? [{ id: 'actions', header: 'Actions', enableSorting: false, cell: ({ row: { original: r } }) => <div className="row-actions"><button className="button secondary" disabled={busy} aria-label={`Edit ${r.name}`} onClick={() => { setCreating(false); setEditing(r); }}>Edit</button>
      <button className="button secondary" disabled={busy} aria-label={`Delete ${r.name}`} onClick={() => { if (window.confirm(`Delete runner ${r.name}? Its credential stops working at once.`)) void act({ action: 'delete', id: r.id }); }}>Delete</button></div> } as DataTableColumn<Runner>] : [{ id: 'scope', header: 'Scope', accessorFn: (r: Runner) => scopeLabel(r.scope) } as DataTableColumn<Runner>]),
  ];
  const data = inventory.data;
  return <section className="page-stack" aria-labelledby="pipeline-runners-title">
    <section className="browser-panel"><div className="browser-panel-heading"><h3 id="pipeline-runners-title">Self-hosted runners</h3>
      <div className="row-actions"><button className="button secondary" aria-label="Refresh runners" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}><RefreshCw size={15} className={inventory.isFetching ? 'spin' : ''} />Refresh</button>
        <button className="button primary" onClick={() => { setEditing(undefined); setCreated(undefined); setCreating(!creating); }} aria-expanded={creating}><Plus size={15} />New runner</button></div></div>
      <p className="field-help">Stock Forgejo Runner and GitLab Runner machines you operate. They run {target.scope === 'installation' ? 'jobs of every repository' : target.scope === 'organization' ? 'jobs of this organization’s repositories' : 'this repository’s jobs'} whose <code>runs-on</code> labels or tags they all carry. Docker, images and network belong to the runner host.</p>
      {error ? <p className="error" role="alert">{message(error)}</p> : null}
      {inventory.isError ? <p className="error" role="alert">{message(inventory.error)}</p> : !data ? <Loading label="Reading runners…" /> :
        <DataTable data={data.runners} columns={columns(true)} getRowId={r => r.id} label="runners" emptyMessage="No runners are registered at this scope yet. Choose New runner to register one." />}
    </section>
    {creating && data ? <NewRunner target={target} inventory={data} close={() => setCreating(false)} done={value => { setCreated(value); setCreating(false); void inventory.refetch(); }} /> : null}
    {created ? <section className="browser-panel credential-form-content pipeline-runner-command" aria-label="Register the runner"><h3>Register the runner</h3>
      <p className="field-help">This registration token is shown once. It expires in the time you chose and works for the number of runners you allowed. Run these commands on the runner host:</p>
      <pre>{created.commands.join('\n')}</pre><div className="credential-actions"><CopyButton text={created.commands.filter(c => !c.startsWith('#')).join('\n')} label="Copy register commands" /><CopyButton text={created.token} label="Copy registration token" /><button className="button secondary" onClick={() => setCreated(undefined)}>Done</button></div>
      {created.engine === 'forgejo-actions' && data ? <p className="field-help">Download forgejo-runner {data.forgejoRunner.version} for linux-amd64 from code.forgejo.org/forgejo/runner/releases and check SHA-256 <code>{data.forgejoRunner.sha256}</code>. Map <code>ubuntu-latest</code> to an image that has the tools your workflows expect.</p> : null}
    </section> : null}
    {editing ? <EditRunner key={editing.id} runner={editing} busy={busy} close={() => setEditing(undefined)} save={async value => { await act({ action: 'update', id: editing.id, ...value }); setEditing(undefined); }} /> : null}
    {data?.tokens.length ? <section className="browser-panel"><div className="browser-panel-heading"><h3>Open registration tokens</h3></div>
      <DataTable data={data.tokens} getRowId={t => t.id} label="registration tokens" pagination={false} columns={[
        { id: 'engine', header: 'Runner', accessorFn: t => engineLabels[t.engine] || t.engine },
        { id: 'labels', header: 'Default labels', accessorFn: t => t.labels.map(labelName).join(', ') || 'Runner chooses' },
        { accessorKey: 'usesLeft', header: 'Uses left' },
        { id: 'expires', header: 'Expires', accessorFn: t => t.expiresAt, cell: ({ row }) => <DateLabel value={row.original.expiresAt} relative /> },
        { id: 'revoke', header: 'Actions', enableSorting: false, cell: ({ row }) => <button className="button secondary" disabled={busy} onClick={() => void act({ action: 'revokeToken', id: row.original.id })}>Revoke</button> },
      ]} /></section> : null}
    {data?.inherited.length ? <section className="browser-panel"><div className="browser-panel-heading"><h3>Shared runners available here</h3></div><DataTable data={data.inherited} columns={columns(false)} getRowId={r => r.id} label="shared runners" pagination={false} /><p className="panel-footnote">Managed at installation or organization scope.</p></section> : null}
  </section>;
}

function NewRunner({ target, inventory, close, done }: { target: Scope; inventory: Inventory; close: () => void; done: (value: { token: string; commands: string[]; engine: string }) => void }) {
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { engine: inventory.engines[0] || 'forgejo-actions', labels: 'ubuntu-latest:docker://ghcr.io/catthehacker/ubuntu:act-24.04', ttlHours: 1, uses: 1 },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const labels = value.labels.split(/[\s,]+/).filter(Boolean);
        const result = await api<{ token: string; commands: string[] }>('/native/pipeline-runners', { ...target, action: 'createToken', engine: value.engine, labels, ttlHours: value.ttlHours, uses: value.uses });
        done({ ...result, engine: value.engine });
      } catch (e) { setError(e); }
    } });
  return <form className="browser-panel credential-form-content" aria-label="New runner" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>New {scopeLabel(target.scope).toLowerCase()} runner</h3>
    <form.Field name="engine">{field => <label>Runner<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>{inventory.engines.map(engine => <option key={engine} value={engine}>{engineLabels[engine] || engine}</option>)}</select></label>}</form.Field>
    <form.Field name="labels">{field => <label>Labels<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="ubuntu-latest:docker://node:20-bookworm" /></label>}</form.Field>
    <p className="field-help">Comma or space separated. A job runs on a runner only when the runner carries every <code>runs-on</code> label (Forgejo) or tag (GitLab). Forgejo labels may name an image after a colon.</p>
    <form.Field name="ttlHours">{field => <label>Token lifetime in hours<input type="number" min={1} max={24} value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>}</form.Field>
    <form.Field name="uses">{field => <label>Runners this token may register<input type="number" min={1} max={100} value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}>Create registration token</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function EditRunner({ runner, busy, close, save }: { runner: Runner; busy: boolean; close: () => void; save: (value: { name: string; labels: string[]; state: Runner['state'] }) => Promise<void> }) {
  const form = useForm({ defaultValues: { name: runner.name, labels: runner.labels.join(', '), state: runner.state }, onSubmit: async ({ value }) => save({ name: value.name, labels: value.labels.split(/[\s,]+/).filter(Boolean), state: value.state }) });
  return <form className="browser-panel credential-form-content" aria-label={`Edit ${runner.name}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Edit {runner.name}</h3>
    <form.Field name="name">{field => <label>Name<input required maxLength={128} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <form.Field name="labels">{field => <label>Labels<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <p className="field-help">A Forgejo Runner replaces its labels from its own configuration each time it starts.</p>
    <form.Field name="state">{field => <label>State<select value={field.state.value} onChange={e => field.handleChange(e.target.value as Runner['state'])}><option value="ACTIVE">Active: takes jobs</option><option value="DISABLED">Disabled: refused at its next call</option></select></label>}</form.Field>
    <div className="credential-actions"><button className="button primary" disabled={busy}>Save runner</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>
  </form>;
}
