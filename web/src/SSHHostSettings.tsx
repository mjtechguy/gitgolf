import { useState, type ComponentType } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { nativeAPI as api } from './nativeAPI';
import { CopyButton, DateLabel, Loading, privateQuery } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { reachLabels, reaches, signedInLabel, toolLabel, tools, type AgentHost, type HostScope, type SSHHost, type SSHInventory, type SSHKeyResult, type SSHReach } from './agentHosts';
import type { HostChanges } from './AgentHostSettings';

// SSH hosts (docs/SSH_HOSTS.md): machines Golf reaches over SSH, inventory first. Add opens the form; after it, Golf shows its public key
// to install and a connection test reports the host key fingerprint for a person to confirm before any task runs there.
const message = (error: unknown) => error instanceof Error ? error.message : 'The SSH host operation could not be confirmed.';
const listText = (values: string) => values.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
type EditForm = ComponentType<{ host: AgentHost; busy: boolean; close: () => void; save: (value: HostChanges) => Promise<void> }>;

function status(host: SSHHost) {
  if (host.probe.state === 'RUNNING') return 'Testing…';
  if (!host.reachAvailable) return 'Reach unavailable';
  if (!host.hostKey.pinned) return host.probe.offered ? 'Host key to confirm' : 'Not tested';
  if (host.probe.state === 'FAILED') return 'Last test failed';
  return host.online ? 'Ready' : 'Test the connection';
}
const detail = (host: SSHHost) => host.probe.state === 'FAILED' || host.probe.error ? host.probe.error : !host.reachAvailable ? host.reachReason : !host.hostKey.pinned ? host.readyReason : '';
// The table shows the start and end of a fingerprint (the whole one is its title, and the review panel shows it in full).
const shortFingerprint = (value: string) => value.length > 30 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value;
const address = (host: SSHHost) => host.reach === 'cloudflare-tunnel' ? `${host.user}@${host.address}` : `${host.user}@${host.address}:${host.port}`;

export function SSHHostSettings({ target, userId, EditHost }: { target: HostScope; userId: string; EditHost: EditForm }) {
  const key = ['native-ssh-hosts', userId, JSON.stringify(target)];
  // A Worker without SSH hosts does not list the capability; one that lists it says in its reason what is missing.
  const runtime = useRuntimeCapabilities(), listed = Boolean(runtime.data?.capabilities.some(capability => capability.id === 'agents.ssh-hosts'));
  const inventory = useQuery({ ...privateQuery, queryKey: key, enabled: listed, queryFn: ({ signal }) => api<SSHInventory>('/native/ssh-hosts', { ...target, action: 'list' }, signal),
    refetchInterval: query => query.state.data?.hosts.some(host => host.probe.state === 'RUNNING') ? 2000 : 15000 });
  const [creating, setCreating] = useState(false), [installing, setInstalling] = useState<SSHKeyResult>(), [reviewing, setReviewing] = useState<string>();
  const [editing, setEditing] = useState<SSHHost>(), [connecting, setConnecting] = useState<SSHHost>();
  const [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const call = async <T,>(path: string, body: object, done?: string) => {
    setBusy(true); setError(undefined); setNotice('');
    try { const result = await api<T>(path, body); if (done) setNotice(done); await inventory.refetch(); return result; } catch (e) { setError(e); return undefined; } finally { setBusy(false); }
  };
  const ssh = <T,>(body: object, done?: string) => call<T>('/native/ssh-hosts', { ...target, ...body }, done);
  const closeAll = () => { setCreating(false); setInstalling(undefined); setReviewing(undefined); setEditing(undefined); setConnecting(undefined); setNotice(''); };
  const data = inventory.data, manage = Boolean(data?.canManage), ready = data?.capability.state === 'CAPABILITY_STATE_READY';
  const test = (host: SSHHost) => void ssh({ action: 'test', id: host.id }, `Testing the connection to ${host.name}…`);
  const reviewed = data?.hosts.find(host => host.id === reviewing);
  const columns: DataTableColumn<SSHHost>[] = [
    { accessorKey: 'name', header: 'Host', cell: ({ row: { original: h } }) => <div className="agent-host-name"><strong>{h.name}</strong><small><code>{address(h)}</code></small>{h.os ? <small>{h.os}/{h.arch}</small> : null}</div> },
    { id: 'reach', header: 'Reach', accessorFn: h => reachLabels[h.reach], cell: ({ row: { original: h } }) => <div>{reachLabels[h.reach]}{h.tailscale?.tags.length ? <small>{h.tailscale.tags.join(', ')}</small> : null}{h.tunnel?.clientId ? <small>Access service token</small> : null}</div> },
    { id: 'status', header: 'Status', accessorFn: status, cell: ({ row: { original: h } }) => <div><span className={`visibility${h.ready && h.online ? ' available' : ''}`}>{status(h)}</span>
      {detail(h) ? <small>{detail(h)}</small> : h.probe.finishedAt ? <small>Tested <DateLabel value={h.probe.finishedAt} relative /></small> : null}</div> },
    { id: 'hostKey', header: 'Host key', accessorFn: h => h.hostKey.fingerprint || h.probe.offered?.fingerprint || '', enableSorting: false,
      cell: ({ row: { original: h } }) => h.hostKey.pinned ? <div><code className="ssh-fingerprint" title={h.hostKey.fingerprint}>{shortFingerprint(h.hostKey.fingerprint)}</code><small>Confirmed by {h.hostKey.pinnedBy || 'a manager'}</small></div>
        : h.probe.offered ? <div><small className="muted">Not confirmed</small>{manage ? <button type="button" className="button secondary" aria-label={`Review the host key of ${h.name}`} onClick={() => { closeAll(); setReviewing(h.id); }}>Review host key</button> : null}</div>
        : <span className="muted">Not confirmed</span> },
    { id: 'tools', header: 'Tools', accessorFn: h => h.tools.map(t => `${toolLabel(t.tool)} ${t.version}`).join(' '), enableSorting: false,
      cell: ({ row: { original: h } }) => h.tools.length ? <ul className="agent-host-tools">{h.tools.map(t => <li key={t.tool}><strong>{toolLabel(t.tool)}</strong> {t.version ? <code>{t.version}</code> : null} <span className={t.signedIn === false ? 'agent-host-signin-no' : t.signedIn === null ? 'muted' : undefined}>{signedInLabel(t.signedIn)}</span>{h.enabledTools.includes(t.tool) ? null : <span className="muted"> · turned off here</span>}</li>)}</ul> : <span className="muted">Reported by a connection test</span> },
    { id: 'tasks', header: 'Active tasks', accessorFn: h => h.activeTasks, sortFn: 'basic', cell: ({ row: { original: h } }) => `${h.activeTasks} of ${h.maxConcurrent}` },
    { id: 'state', header: 'State', accessorFn: h => h.state === 'ACTIVE' ? 'Active' : 'Disabled' },
    ...(manage ? [{ id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: h } }) => <div className="row-actions">
      <button className="button secondary" disabled={busy || h.probe.state === 'RUNNING' || !h.reachAvailable} aria-label={`Test the connection to ${h.name}`} onClick={() => test(h)}>Test connection</button>
      <button className="button secondary" disabled={busy} aria-label={`Edit ${h.name}`} onClick={() => { closeAll(); setEditing(h); }}>Edit</button>
      <button className="button secondary" disabled={busy} aria-label={`Connection settings of ${h.name}`} onClick={() => { closeAll(); setConnecting(h); }}>Connection</button>
      <button className="button secondary" disabled={busy} aria-label={`Show Golf’s key for ${h.name}`} onClick={() => { closeAll(); setInstalling({ host: h, publicKey: h.publicKey || '', authorizedKey: `restrict ${h.publicKey}`, installCommand: `umask 077 && mkdir -p ~/.ssh && printf '%s\\n' 'restrict ${h.publicKey}' >> ~/.ssh/authorized_keys` }); }}>Key</button>
      <button className="button secondary danger-action" disabled={busy} aria-label={`Delete ${h.name}`} onClick={() => { if (window.confirm(`Delete SSH host ${h.name}? Golf erases its key for it, cancels queued tasks and stops running ones.`)) { closeAll(); void ssh({ action: 'delete', id: h.id }, `${h.name} was deleted.`); } }}>Delete</button></div> } as DataTableColumn<SSHHost>] : []),
  ];
  if (!listed) return null;
  return <>
    <section className="browser-panel" aria-labelledby="ssh-hosts-title"><div className="browser-panel-heading"><h2 id="ssh-hosts-title">SSH hosts</h2>
      <div className="row-actions"><button className="button secondary" aria-label="Refresh SSH hosts" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}><RefreshCw size={15} className={inventory.isFetching ? 'spin' : ''} />Refresh</button>
        {manage ? <button className="button primary" disabled={!ready} onClick={() => { const open = !creating; closeAll(); setCreating(open); }} aria-expanded={creating}><Plus size={15} />Add SSH host</button> : null}</div></div>
      <p className="field-help">Machines Golf connects to over SSH, with Codex, Claude Code, OpenCode or Grok already installed and signed in there. No Golf software runs on them: Golf signs in with a key it generates for each host, copies a fresh working copy there for each task and brings the changes back as a proposal branch. Use a dedicated account on the machine.</p>
      {data && !ready ? <p className="field-help" role="status">{data.capability.reason}</p> : null}
      {notice ? <p className="field-help" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{message(error)}</p> : null}
      {inventory.isError ? <p className="error" role="alert">{message(inventory.error)}</p> : !data ? <Loading label="Reading SSH hosts…" /> :
        <DataTable data={data.hosts} columns={columns} getRowId={h => h.id} label="SSH hosts" emptyMessage={manage ? 'No SSH hosts yet. Choose Add SSH host to connect a machine over SSH.' : 'No SSH hosts are registered here.'} />}
    </section>
    {creating && manage && data ? <NewSSHHost target={target} inventory={data} close={() => setCreating(false)} done={value => { closeAll(); setInstalling(value); void inventory.refetch(); }} /> : null}
    {installing ? <section className="browser-panel credential-form-content pipeline-runner-command" aria-label="Install Golf’s key"><h3>Install Golf’s key on {installing.host.name}</h3>
      <p className="field-help">Add this line to <code>~/.ssh/authorized_keys</code> of <code>{installing.host.user}</code> on the machine. <code>restrict</code> turns off forwarding and terminals for this key. Golf keeps the private key sealed and never shows it.</p>
      <pre>{installing.authorizedKey}</pre>
      <p className="field-help">Or run this on the machine as {installing.host.user}:</p>
      <pre>{installing.installCommand}</pre>
      <div className="credential-actions"><CopyButton text={installing.authorizedKey} label="Copy key line" /><CopyButton text={installing.installCommand} label="Copy command" />
        <button className="button primary" disabled={busy || !installing.host.reachAvailable} onClick={() => { test(installing.host); setInstalling(undefined); }}>Test connection</button><button className="button secondary" onClick={() => setInstalling(undefined)}>Done</button></div>
      <p className="field-help">Key fingerprint <code className="ssh-fingerprint">{installing.host.keyFingerprint}</code>.</p>
    </section> : null}
    {reviewed?.probe.offered && manage ? <HostKeyReview host={reviewed} busy={busy} close={() => setReviewing(undefined)}
      trust={async () => { if (await ssh({ action: 'trustHostKey', id: reviewed.id, expectedVersion: reviewed.version, fingerprint: reviewed.probe.offered!.fingerprint }, `The host key of ${reviewed.name} is pinned. Testing the connection with it…`)) { setReviewing(undefined); await ssh({ action: 'test', id: reviewed.id }); } }} /> : null}
    {editing && manage ? <EditHost key={`${editing.id}/${editing.version}`} host={editing} busy={busy} close={() => setEditing(undefined)}
      save={async value => { if (await call('/native/agent-hosts', { action: 'update', id: editing.id, expectedVersion: editing.version, ...value }, `${value.name} was saved.`)) setEditing(undefined); }} /> : null}
    {connecting && manage && data ? <ConnectionForm key={`${connecting.id}/${connecting.version}`} host={connecting} inventory={data} busy={busy} close={() => setConnecting(undefined)}
      save={async value => { if (await ssh({ action: 'update', id: connecting.id, expectedVersion: connecting.version, ...value }, `The connection of ${value.name} was saved.`)) setConnecting(undefined); }} /> : null}
  </>;
}

function HostKeyReview({ host, busy, close, trust }: { host: SSHHost; busy: boolean; close: () => void; trust: () => Promise<void> }) {
  const offered = host.probe.offered!, changed = host.hostKey.pinned && host.hostKey.fingerprint !== offered.fingerprint;
  return <section className="browser-panel credential-form-content" aria-label={`Host key of ${host.name}`}><h3>Confirm the host key of {host.name}</h3>
    {changed ? <p className="error" role="alert">This is not the key Golf pinned before. Trust it only if you know the machine was reinstalled or its keys were replaced.</p> : null}
    <p className="field-help">The last connection test was offered this {offered.type} host key. Compare it with the key on the machine before trusting it; Golf refuses every connection whose key differs from the one you confirm.</p>
    <pre className="ssh-fingerprint">{offered.fingerprint}</pre>
    <p className="field-help">On the machine: <code>ssh-keygen -lf /etc/ssh/ssh_host_{offered.type === 'ssh-ed25519' ? 'ed25519' : offered.type.startsWith('ecdsa') ? 'ecdsa' : 'rsa'}_key.pub</code></p>
    <div className="credential-actions"><button className="button primary" disabled={busy} onClick={() => void trust()}>Trust this host key</button><button className="button secondary" onClick={close}>Cancel</button></div>
  </section>;
}

type ConnectionValues = { name: string; address: string; port: number; user: string; workDirectory: string; reach: SSHReach; authKey: string; tags: string; clientId: string; clientSecret: string };
// The body for create and update: secrets only when typed (an empty field keeps the stored one), reach settings only for their reach.
function connectionBody(value: ConnectionValues, editing: boolean) {
  const body: Record<string, unknown> = { name: value.name.trim(), address: value.address.trim(), port: value.port, user: value.user.trim(), workDirectory: value.workDirectory.trim(), reach: value.reach };
  if (value.reach === 'tailscale') body.tailscale = { tags: listText(value.tags), ...(value.authKey || !editing ? { authKey: value.authKey.trim() } : {}) };
  if (value.reach === 'cloudflare-tunnel') body.tunnel = { clientId: value.clientId.trim(), ...(value.clientSecret || !editing || !value.clientId ? { clientSecret: value.clientSecret.trim() } : {}) };
  return body;
}

function ConnectionFields({ form, inventory, editing }: { form: any; inventory: SSHInventory; editing?: SSHHost }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return <>
    <form.Field name="name">{(field: any) => <label>Name<input required maxLength={128} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <form.Field name="reach">{(field: any) => <label>Reach<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>
      {reaches.map(reach => <option key={reach} value={reach} disabled={!inventory.reaches[reach]?.available}>{reachLabels[reach]}{inventory.reaches[reach]?.available ? '' : ' (unavailable)'}</option>)}</select></label>}</form.Field>
    <form.Subscribe selector={(state: any) => state.values.reach}>{(reach: SSHReach) => <>
      <p className="field-help">{reach === 'direct' ? 'Golf connects to the address from Cloudflare’s network: the SSH port must be reachable from the Internet.'
        : reach === 'tailscale' ? 'Each task joins your tailnet as an ephemeral node with userspace networking, connects through it, and logs out at the end. Create a reusable, ephemeral, pre-approved auth key, tagged for the tags below, and allow those tags to reach the machine’s SSH port in your tailnet policy.'
        : reach === 'cloudflare-tunnel' ? 'The machine runs cloudflared with a public hostname for its SSH service behind Cloudflare Access; Golf connects with cloudflared access ssh, signing in with an Access service token when the application needs one.'
        : 'Golf’s Durable Object opens the connection through this Worker’s Workers VPC network binding and bridges it to the task container.'}</p>
      {inventory.reaches[reach] && !inventory.reaches[reach].available ? <p className="error" role="alert">{inventory.reaches[reach].reason}</p> : null}
      <form.Field name="address">{(field: any) => <label>{reach === 'cloudflare-tunnel' ? 'Access hostname' : 'Address'}<input required maxLength={253} value={field.state.value} placeholder={reach === 'tailscale' ? 'build-box.tail1234.ts.net' : reach === 'cloudflare-tunnel' ? 'ssh.example.com' : 'build.example.com'} autoComplete="off" onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
      {reach === 'cloudflare-tunnel' ? null : <form.Field name="port">{(field: any) => <label>Port<input type="number" min={1} max={65535} required value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>}</form.Field>}
      {reach === 'tailscale' ? <>
        <form.Field name="authKey">{(field: any) => <label>Tailscale auth key<input type="password" autoComplete="off" required={!editing?.tailscale} placeholder={editing?.tailscale ? 'Stored; type a new key to replace it' : 'tskey-auth-…'} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
        <form.Field name="tags">{(field: any) => <label>Tags<input value={field.state.value} placeholder="tag:golf-agent" autoComplete="off" onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
      </> : null}
      {reach === 'cloudflare-tunnel' ? <>
        <form.Field name="clientId">{(field: any) => <label>Access service token ID <span className="optional">optional</span><input value={field.state.value} autoComplete="off" onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
        <form.Field name="clientSecret">{(field: any) => <label>Access service token secret <span className="optional">optional</span><input type="password" autoComplete="off" placeholder={editing?.tunnel?.clientSecretSet ? 'Stored; type a new secret to replace it' : ''} value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
      </> : null}
    </>}</form.Subscribe>
    <form.Field name="user">{(field: any) => <label>Account<input required maxLength={32} value={field.state.value} placeholder="golf-agent" autoComplete="off" onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <form.Field name="workDirectory">{(field: any) => <label>Work directory <span className="optional">optional</span><input value={field.state.value} placeholder="Default: ~/.golf-agent/work" autoComplete="off" onChange={e => field.handleChange(e.target.value)} /></label>}</form.Field>
    <p className="field-help">An absolute path; each task gets its own directory below it, removed when the task ends. The tools must be on the account’s login-shell PATH, and the account needs a POSIX shell and tar.</p>
  </>;
}

function NewSSHHost({ target, inventory, close, done }: { target: HostScope; inventory: SSHInventory; close: () => void; done: (value: SSHKeyResult) => void }) {
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { name: '', address: '', port: 22, user: '', workDirectory: '', reach: 'direct' as SSHReach, authKey: '', tags: '', clientId: '', clientSecret: '', enabledTools: [...tools] as string[] },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try { done(await api<SSHKeyResult>('/native/ssh-hosts', { ...target, action: 'create', ...connectionBody(value, false), enabledTools: value.enabledTools })); } catch (e) { setError(e); }
    } });
  return <form className="browser-panel credential-form-content" aria-label="Add SSH host" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Add SSH host</h3>
    <ConnectionFields form={form} inventory={inventory} />
    <form.Field name="enabledTools">{field => <fieldset className="policy-choices"><legend>Tools Golf may run there</legend>{tools.map(tool => <label key={tool} className="policy-choice">
      <input type="checkbox" checked={field.state.value.includes(tool)} onChange={e => field.handleChange(e.target.checked ? [...field.state.value, tool] : field.state.value.filter(value => value !== tool))} />
      <span><strong>{toolLabel(tool)}</strong><small>Reported by the connection test</small></span></label>)}</fieldset>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => state.isSubmitting}>{submitting => <div className="credential-actions"><button className="button primary" disabled={submitting}>Add SSH host</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function ConnectionForm({ host, inventory, busy, close, save }: { host: SSHHost; inventory: SSHInventory; busy: boolean; close: () => void; save: (value: Record<string, unknown>) => Promise<void> }) {
  const form = useForm({ defaultValues: { name: host.name, address: host.address, port: host.port, user: host.user, workDirectory: host.workDirectory, reach: host.reach, authKey: '', tags: host.tailscale?.tags.join(', ') || '', clientId: host.tunnel?.clientId || '', clientSecret: '' },
    onSubmit: async ({ value }) => save(connectionBody(value, value.reach === host.reach)) });
  return <form className="browser-panel credential-form-content" aria-label={`Connection of ${host.name}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Connection of {host.name}</h3>
    <p className="field-help">A new address, port or reach forgets the confirmed host key: test the connection and confirm it again before the next task.</p>
    <ConnectionFields form={form} inventory={inventory} editing={host} />
    <div className="credential-actions"><button className="button primary" disabled={busy}>Save connection</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>
  </form>;
}
