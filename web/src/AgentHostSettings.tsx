import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { nativeAPI as api } from './nativeAPI';
import { CopyButton, DateLabel, Loading, privateQuery } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';
import { scopeLabels, signedInLabel, toolLabel, tools, type AgentHost, type HostInventory, type HostScope } from './agentHosts';

const message = (error: unknown) => error instanceof Error ? error.message : 'The agent host operation could not be confirmed.';
// Connection only; the State column says whether the host takes tasks.
const status = (host: AgentHost) => host.online ? 'Online' : 'Offline';
const listText = (values: string) => values.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
const scopeReach: Record<HostScope['scope'], string> = {
  personal: 'Machines you connect run the coding tools already installed and signed in there, for issues and pull requests in repositories you can write.',
  organization: 'Machines this organization’s owners connect run coding tools for issues and pull requests in the organization’s repositories.',
  installation: 'Machines operations administrators connect run coding tools for issues and pull requests in every repository on this installation.',
};

function sharing(host: AgentHost) {
  const users = host.allowedUsers.length;
  if (host.scope === 'personal') return host.shareSignins && users ? `Shared with ${users} ${users === 1 ? 'user' : 'users'}, using your sign-ins` : 'Only you';
  const who = users ? `${users} listed ${users === 1 ? 'user' : 'users'}` : 'Everyone in scope';
  return host.shareSignins ? `${who}, using the registrant’s sign-ins` : `Registrant only (sign-ins not shared)`;
}

// One inventory for personal, organization and installation hosts; the scope decides who manages it.
export function AgentHostSettings({ target, userId }: { target: HostScope; userId: string }) {
  const key = ['native-agent-hosts', userId, JSON.stringify(target)];
  const inventory = useQuery({ ...privateQuery, queryKey: key, queryFn: ({ signal }) => api<HostInventory>('/native/agent-hosts', { ...target, action: 'list' }, signal), refetchInterval: 15000 });
  const [creating, setCreating] = useState(false), [editing, setEditing] = useState<AgentHost>(), [created, setCreated] = useState<{ token: string; commands: string[] }>();
  const [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const act = async (body: object, done?: string) => {
    setBusy(true); setError(undefined); setNotice('');
    try { await api('/native/agent-hosts', body); if (done) setNotice(done); await inventory.refetch(); return true; } catch (e) { setError(e); return false; } finally { setBusy(false); }
  };
  const data = inventory.data, manage = Boolean(data?.canManage);
  const columns: DataTableColumn<AgentHost>[] = [
    { accessorKey: 'name', header: 'Host', cell: ({ row: { original: h } }) => <div className="agent-host-name"><strong>{h.name}</strong><small>{[h.os && h.arch ? `${h.os}/${h.arch}` : h.os, h.hostVersion ? `golf-agent-host ${h.hostVersion}` : ''].filter(Boolean).join(' · ') || 'Not reported yet'}</small></div> },
    { id: 'status', header: 'Status', accessorFn: status, cell: ({ row: { original: h } }) => <div><span className={`visibility${h.state === 'ACTIVE' && h.online ? ' available' : ''}`}>{status(h)}</span><small>{h.lastSeenAt ? <>Last seen <DateLabel value={h.lastSeenAt} relative /></> : 'Never called in'}</small></div> },
    { id: 'tools', header: 'Tools', accessorFn: h => h.tools.map(t => `${toolLabel(t.tool)} ${t.version} ${signedInLabel(t.signedIn)}`).join(' '), enableSorting: false,
      cell: ({ row: { original: h } }) => h.tools.length ? <ul className="agent-host-tools">{h.tools.map(t => <li key={t.tool}><strong>{toolLabel(t.tool)}</strong> {t.version ? <code>{t.version}</code> : null} <span className={t.signedIn === false ? 'agent-host-signin-no' : t.signedIn === null ? 'muted' : undefined}>{signedInLabel(t.signedIn)}</span>{h.enabledTools.includes(t.tool) ? null : <span className="muted"> · turned off here</span>}</li>)}</ul> : <span className="muted">None reported</span> },
    { id: 'scope', header: 'Scope', accessorFn: h => scopeLabels[h.scope] || h.scope },
    { id: 'sharing', header: 'Sharing', accessorFn: sharing },
    { id: 'tasks', header: 'Active tasks', accessorFn: h => h.activeTasks, sortFn: 'basic', cell: ({ row: { original: h } }) => `${h.activeTasks} of ${h.maxConcurrent}` },
    { id: 'state', header: 'State', accessorFn: h => h.state === 'ACTIVE' ? 'Active' : 'Disabled' },
    ...(manage ? [{ id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: h } }) => <div className="row-actions">
      <button className="button secondary" disabled={busy} aria-label={`Edit ${h.name}`} onClick={() => { setCreating(false); setCreated(undefined); setNotice(''); setEditing(h); }}>Edit</button>
      <button className="button secondary danger-action" disabled={busy} aria-label={`Delete ${h.name}`} onClick={() => { if (window.confirm(`Delete agent host ${h.name}? Its credential stops working at once, queued tasks are cancelled and running tasks are cancelled at its next call.`)) { if (editing?.id === h.id) setEditing(undefined); void act({ action: 'delete', id: h.id }, `${h.name} was deleted.`); } }}>Delete</button></div> } as DataTableColumn<AgentHost>] : []),
  ];
  return <div className="page-stack">
    <section className="browser-panel" aria-labelledby="agent-hosts-title"><div className="browser-panel-heading"><h2 id="agent-hosts-title">Agent hosts</h2>
      <div className="row-actions"><button className="button secondary" aria-label="Refresh agent hosts" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}><RefreshCw size={15} className={inventory.isFetching ? 'spin' : ''} />Refresh</button>
        {manage ? <button className="button primary" onClick={() => { setEditing(undefined); setCreated(undefined); setNotice(''); setCreating(!creating); }} aria-expanded={creating}><Plus size={15} />New host</button> : null}</div></div>
      <p className="field-help">{scopeReach[target.scope]} Golf assigns them work from an issue or a pull request; each task ends as a proposal branch that a person turns into a pull request.</p>
      {notice ? <p className="field-help" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{message(error)}</p> : null}
      {inventory.isError ? <p className="error" role="alert">{message(inventory.error)}</p> : !data ? <Loading label="Reading agent hosts…" /> :
        <DataTable data={data.hosts} columns={columns} getRowId={h => h.id} label="agent hosts" emptyMessage={manage ? 'No agent hosts are registered here yet. Choose New host to connect a machine.' : 'No agent hosts are registered here.'} />}
      {data && !manage ? <p className="panel-footnote">{target.scope === 'organization' ? 'Organization owners manage these hosts.' : target.scope === 'installation' ? 'Operations administrators manage these hosts.' : 'You can read these hosts but not change them.'}</p> : null}
    </section>
    {creating && manage ? <NewHost target={target} close={() => setCreating(false)} done={value => { setCreated(value); setCreating(false); void inventory.refetch(); }} /> : null}
    {created ? <section className="browser-panel credential-form-content pipeline-runner-command" aria-label="Connect the host"><h3>Connect the host</h3>
      <p className="field-help">This registration token is shown once. It expires after the lifetime you chose and registers the number of hosts you allowed. On the machine, with <code>golf-agent-host</code> installed and your coding tools already signed in, run:</p>
      <pre>{created.commands.join('\n')}</pre>
      <div className="credential-actions"><CopyButton text={created.commands.filter(c => !c.startsWith('#')).join('\n')} label="Copy commands" /><CopyButton text={created.token} label="Copy registration token" /><button className="button secondary" onClick={() => setCreated(undefined)}>Done</button></div>
      <p className="field-help">The host keeps its own credential in its state directory. Golf never receives your tool sign-ins; the host reports only each tool’s version and whether it is signed in.</p>
    </section> : null}
    {editing && manage ? <EditHost key={`${editing.id}/${editing.version}`} host={editing} busy={busy} close={() => setEditing(undefined)}
      save={async value => { if (await act({ action: 'update', id: editing.id, expectedVersion: editing.version, ...value }, `${value.name} was saved.`)) setEditing(undefined); }} /> : null}
    {data?.tokens.length ? <section className="browser-panel" aria-labelledby="agent-host-tokens-title"><div className="browser-panel-heading"><h3 id="agent-host-tokens-title">Open registration tokens</h3></div>
      <DataTable data={data.tokens} getRowId={t => t.id} label="agent host registration tokens" pagination={false} columns={[
        { accessorKey: 'id', header: 'Token', cell: ({ row }) => <code>{row.original.id}</code> },
        { accessorKey: 'usesLeft', header: 'Hosts left', sortFn: 'basic' },
        { id: 'expires', header: 'Expires', accessorFn: t => t.expiresAt, cell: ({ row }) => <DateLabel value={row.original.expiresAt} relative /> },
        ...(manage ? [{ id: 'revoke', header: 'Actions', enableSorting: false, cell: ({ row }) => <button className="button secondary" disabled={busy} aria-label={`Revoke token ${row.original.id}`} onClick={() => void act({ action: 'revokeToken', id: row.original.id }, 'The registration token was revoked.')}>Revoke</button> } as DataTableColumn<{ id: string; expiresAt: string; usesLeft: number }>] : []),
      ]} /></section> : null}
  </div>;
}

function NewHost({ target, close, done }: { target: HostScope; close: () => void; done: (value: { token: string; commands: string[] }) => void }) {
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { ttlHours: 1, uses: 1 }, onSubmit: async ({ value }) => {
    setError(undefined);
    try { done(await api<{ token: string; commands: string[] }>('/native/agent-hosts', { ...target, action: 'createToken', ttlHours: value.ttlHours, uses: value.uses })); } catch (e) { setError(e); }
  } });
  return <form className="browser-panel credential-form-content" aria-label="New agent host" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>New {scopeLabels[target.scope]!.toLowerCase()} agent host</h3>
    <p className="field-help">Golf creates a short-lived registration token and the exact commands to run on the machine.</p>
    <form.Field name="ttlHours">{field => <label>Token lifetime in hours<input type="number" min={1} max={24} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>}</form.Field>
    <form.Field name="uses">{field => <label>Hosts this token may register<input type="number" min={1} max={10} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}>Create registration token</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

type HostChanges = { name: string; state: AgentHost['state']; shareSignins: boolean; allowedUsers: string[]; allowedRepositories: string[]; enabledTools: string[]; maxConcurrent: number };
function EditHost({ host, busy, close, save }: { host: AgentHost; busy: boolean; close: () => void; save: (value: HostChanges) => Promise<void> }) {
  const personal = host.scope === 'personal';
  const form = useForm({ defaultValues: { name: host.name, state: host.state, shareSignins: host.shareSignins, allowedUsers: host.allowedUsers.join(', '), allowedRepositories: host.allowedRepositories.join(', '), enabledTools: host.enabledTools, maxConcurrent: host.maxConcurrent },
    onSubmit: async ({ value }) => save({ ...value, name: value.name.trim(), allowedUsers: listText(value.allowedUsers), allowedRepositories: listText(value.allowedRepositories) }) });
  return <form className="browser-panel credential-form-content" aria-label={`Edit ${host.name}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Edit {host.name}</h3>
    <form.Field name="name">{field => <label>Name<input required maxLength={128} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <form.Field name="state">{field => <label>State<select value={field.state.value} onChange={e => field.handleChange(e.target.value as AgentHost['state'])}><option value="ACTIVE">Active: takes tasks</option><option value="DISABLED">Disabled: takes no new tasks</option></select></label>}</form.Field>
    <form.Field name="shareSignins">{field => <label className="checkbox-field"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} />Share sign-ins with allowed users</label>}</form.Field>
    <p className="field-help">{personal
      ? 'When on, the users you list below can assign tasks to this machine, and those tasks run under your own signed-in subscriptions (your Codex, Claude, OpenCode or Grok accounts, their limits and their bills). When off, only you can use this host.'
      : 'When on, every allowed user can run tasks here, and those tasks run under the signed-in subscriptions of the host’s owner, the person who registered it (their accounts, limits and bills). When off, only the registrant can run tasks on this host.'}</p>
    <form.Field name="allowedUsers">{field => <label>Allowed users<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="login, login" autoComplete="off" /></label>}</form.Field>
    <p className="field-help">{personal ? 'Logins of people who may use this host when sign-ins are shared. You always can.' : 'Logins, comma separated. Empty means everyone in scope.'}</p>
    <form.Field name="allowedRepositories">{field => <label>Allowed repositories<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="owner/name, owner/name" autoComplete="off" /></label>}</form.Field>
    <p className="field-help">Empty means every repository this host’s scope covers.</p>
    <form.Field name="enabledTools">{field => <fieldset className="policy-choices"><legend>Enabled tools</legend>{tools.map(tool => { const reported = host.tools.find(t => t.tool === tool); return <label key={tool} className="policy-choice">
      <input type="checkbox" checked={field.state.value.includes(tool)} onChange={e => field.handleChange(e.target.checked ? [...field.state.value, tool] : field.state.value.filter(value => value !== tool))} />
      <span><strong>{toolLabel(tool)}</strong><small>{reported ? `${reported.version || 'version unknown'} · ${signedInLabel(reported.signedIn)}` : 'Not installed on this host'}</small></span></label>; })}</fieldset>}</form.Field>
    <form.Field name="maxConcurrent">{field => <label>Tasks at once<input type="number" min={1} max={4} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>}</form.Field>
    <p className="field-help">How many tasks this host runs at the same time, at most four.</p>
    <div className="credential-actions"><button className="button primary" disabled={busy}>Save host</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>
  </form>;
}
