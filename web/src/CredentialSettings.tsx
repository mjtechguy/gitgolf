import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { nativeAPI as api } from './nativeAPI';
import { DateLabel, Loading, privateQuery } from './RepositoryUI';
import { DataTable, type DataTableColumn } from './DataTable';
import { credentialMessage as message, grantText, placeLabels, providerLabel, type Credential, type CredentialInventory, type CredentialTarget, type Place } from './vault';

// The credential vault (docs/CREDENTIAL_VAULT.md): one inventory for personal, organization and installation credentials. Values go in once
// and never come back; the inventory shows labels, the last four characters of API keys, who may use each one and when it was last used.
const scopeText: Record<CredentialTarget['scope'], string> = {
  user: 'Your API keys and subscription sign-ins. Golf seals each value with envelope encryption under the installation’s Secrets Store key and never shows it again. Only you can use them unless you share one.',
  organization: 'API keys this organization’s owners add for its engines. Golf seals each value and never shows it again. Sharing is explicit: choose the organization’s members, a repository or a person.',
  installation: 'API keys operations administrators add for installation engines. Golf seals each value and never shows it again. Sharing is explicit: everyone on the installation, an organization, a repository or a person.',
};
type Mode = { kind: 'add'; credential: 'api-key' | 'subscription' } | { kind: 'rotate' | 'share'; credential: Credential };

export function CredentialSettings({ target, userId }: { target: CredentialTarget; userId: string }) {
  const inventory = useQuery({ ...privateQuery, queryKey: ['native-credentials', userId, JSON.stringify(target)], queryFn: ({ signal }) => api<CredentialInventory>('/native/credentials', { ...target, action: 'list' }, signal) });
  const [mode, setMode] = useState<Mode>(), [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const data = inventory.data, manage = Boolean(data?.canManage && data.ready);
  const open = (next: Mode) => { setNotice(''); setError(undefined); setMode(next); };
  const revoke = async (credential: Credential) => {
    if (!window.confirm(`Revoke ${credential.label}? Golf destroys the sealed value now; engines that use it stop at their next call. Revoke it at ${providerLabel(credential.provider)} too if it may have leaked.`)) return;
    setBusy(true); setError(undefined); setNotice('');
    try { await api('/native/credentials', { action: 'revoke', id: credential.id }); setNotice(`${credential.label} was revoked.`); setMode(undefined); await inventory.refetch(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const columns: DataTableColumn<Credential>[] = [
    { accessorKey: 'label', header: 'Credential', cell: ({ row: { original: c } }) => <div><strong>{c.label}</strong><small className="muted"> · {providerLabel(c.provider)} {c.kind === 'api-key' ? 'API key' : 'subscription sign-in'}{c.tool ? ` (${c.tool})` : ''}</small></div> },
    { id: 'fingerprint', header: 'Value', accessorFn: c => c.fingerprint, cell: ({ row: { original: c } }) => c.state === 'revoked' ? <span className="muted">Destroyed</span> : c.fingerprint ? <code>{c.fingerprint}</code> : <span className="muted">{c.valueBytes.toLocaleString('en-US')} bytes, sealed</span> },
    { id: 'shared', header: 'Who may use it', accessorFn: c => grantText(c.grants) },
    { id: 'used', header: 'Last used', accessorFn: c => c.lastUsedAt, cell: ({ row: { original: c } }) => c.lastUsedAt ? <DateLabel value={c.lastUsedAt} relative /> : <span className="muted">Never</span> },
    { id: 'state', header: 'State', accessorFn: c => c.state, cell: ({ row: { original: c } }) => <div><span className={`visibility${c.usable ? ' available' : ''}`}>{c.state === 'revoked' ? 'Revoked' : c.usable ? 'Usable' : 'Stored'}</span>{c.usableReason && c.state !== 'revoked' ? <small className="muted"> {c.usableReason}</small> : null}{c.rotatedAt ? <small className="muted"> · rotated <DateLabel value={c.rotatedAt} relative /></small> : null}</div> },
    ...(manage ? [{ id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row: { original: c } }) => c.state === 'revoked' ? null : <div className="row-actions">
      <button className="button secondary" disabled={busy} aria-label={`Rotate ${c.label}`} onClick={() => open({ kind: 'rotate', credential: c })}>Rotate</button>
      <button className="button secondary" disabled={busy} aria-label={`Share ${c.label}`} onClick={() => open({ kind: 'share', credential: c })}>Share</button>
      <button className="button secondary danger-action" disabled={busy} aria-label={`Revoke ${c.label}`} onClick={() => void revoke(c)}>Revoke</button></div> } as DataTableColumn<Credential>] : []),
  ];
  const shared: DataTableColumn<Credential>[] = [...columns.filter(c => c.id === undefined), { id: 'scope', header: 'From', accessorFn: c => c.scope === 'installation' ? 'Installation' : c.scope === 'organization' ? 'Organization' : 'A person' },
    ...columns.filter(c => c.id === 'fingerprint' || c.id === 'state')];
  const saved = async (text: string) => { setMode(undefined); setNotice(text); await inventory.refetch(); };
  const current = mode && mode.kind !== 'add' ? data?.credentials.find(c => c.id === mode.credential.id) || mode.credential : undefined;
  return <div className="page-stack">
    <section className="browser-panel" aria-labelledby="credentials-title"><div className="browser-panel-heading"><h2 id="credentials-title">{target.scope === 'user' ? 'Your credentials' : 'Credentials'}</h2>
      <div className="row-actions"><button className="button secondary" aria-label="Refresh credentials" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}><RefreshCw size={15} className={inventory.isFetching ? 'spin' : ''} />Refresh</button>
        {manage ? <button className="button primary" aria-expanded={mode?.kind === 'add' && mode.credential === 'api-key'} onClick={() => open({ kind: 'add', credential: 'api-key' })}><Plus size={15} />Add API key</button> : null}
        {manage && target.scope === 'user' ? <button className="button secondary" aria-expanded={mode?.kind === 'add' && mode.credential === 'subscription'} onClick={() => open({ kind: 'add', credential: 'subscription' })}><Plus size={15} />Add subscription sign-in</button> : null}</div></div>
      <p className="field-help">{scopeText[target.scope]}</p>
      {data && !data.ready ? <p className="error" role="alert">{data.reason}</p> : null}
      {notice ? <p className="field-help" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{message(error)}</p> : null}
      {inventory.isError ? <p className="error" role="alert">{message(inventory.error)}</p> : !data ? <Loading label="Reading credentials…" /> :
        <DataTable data={data.credentials} columns={columns} getRowId={c => c.id} label="credentials" emptyMessage={manage ? 'No credentials yet. Choose Add API key to add one.' : 'No credentials here.'} />}
      {data && !data.canManage ? <p className="panel-footnote">{target.scope === 'organization' ? 'Organization owners manage these credentials; members see their labels only.' : 'You can read these credentials but not change them.'}</p> : null}
    </section>
    {mode?.kind === 'add' && data ? <AddCredential key={mode.credential} target={target} kind={mode.credential} inventory={data} close={() => setMode(undefined)} done={saved} /> : null}
    {mode?.kind === 'rotate' && current ? <RotateCredential key={current.id} credential={current} close={() => setMode(undefined)} done={saved} /> : null}
    {mode?.kind === 'share' && current && data ? <ShareCredential key={current.id} target={target} credential={current} places={data.places} close={() => setMode(undefined)} refresh={async () => { await inventory.refetch(); }} /> : null}
    {target.scope === 'user' && data?.sharedWithYou.length ? <section className="browser-panel" aria-labelledby="credentials-shared-title"><div className="browser-panel-heading"><h2 id="credentials-shared-title">Shared with you</h2></div>
      <p className="field-help">Credentials an owner shared with you, your organization or a repository you work in. You can use them through engines; you cannot read, rotate or share them.</p>
      <DataTable data={data.sharedWithYou} columns={shared} getRowId={c => c.id} label="credentials shared with you" /></section> : null}
  </div>;
}

function AddCredential({ target, kind, inventory, close, done }: { target: CredentialTarget; kind: 'api-key' | 'subscription'; inventory: CredentialInventory; close: () => void; done: (text: string) => Promise<void> }) {
  const [error, setError] = useState<unknown>();
  const subscription = kind === 'subscription';
  const form = useForm({ defaultValues: { label: '', provider: subscription ? 'openai' : 'anthropic', tool: 'codex', value: '', shareEveryone: target.scope === 'installation', shareOrganization: target.scope === 'organization', acceptTerms: false },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const grants = target.scope === 'installation' && value.shareEveryone ? [{ granteeKind: 'installation' }] : target.scope === 'organization' && value.shareOrganization ? [{ granteeKind: 'organization', grantee: target.organization }] : [];
        await api('/native/credentials', { ...target, action: 'create', kind, provider: value.provider, ...(subscription ? { tool: value.tool, acceptTerms: value.acceptTerms } : {}), label: value.label.trim(), value: subscription ? value.value : value.value.trim(), grants });
        await done(`${value.label.trim()} was added and sealed. Golf will not show its value again.`);
      } catch (e) { setError(e); }
    } });
  const tools = inventory.tools;
  return <form className="browser-panel credential-form-content" aria-label={subscription ? 'Add subscription sign-in' : 'Add API key'} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>{subscription ? 'Add a subscription sign-in' : 'Add an API key'}</h3>
    {subscription ? <div className="field-help check-warning" role="note"><strong>Before you upload a sign-in.</strong> A token file signs in as you, with your plan. {inventory.subscriptionTerms} Golf seals the whole file; it is never shown again and nobody else can use it unless you share it. Running subscription sign-ins in cloud sandboxes is not available yet, so Golf refuses to use it for now.</div> : null}
    <form.Field name="label">{field => <label>Name<input required maxLength={64} value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder={subscription ? 'My ChatGPT sign-in' : 'Team Anthropic key'} autoComplete="off" /></label>}</form.Field>
    {subscription ? <form.Field name="tool">{field => <label>Coding CLI<select value={field.state.value} onChange={e => { field.handleChange(e.target.value); const providers = tools.find(t => t.id === e.target.value)?.providers || []; if (!providers.includes(form.getFieldValue('provider'))) form.setFieldValue('provider', providers[0] || 'openai'); }}>
      {tools.map(tool => <option key={tool.id} value={tool.id}>{tool.label}</option>)}</select></label>}</form.Field> : null}
    <form.Subscribe selector={state => state.values.tool}>{tool => <form.Field name="provider">{field => <label>Provider<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>
      {inventory.providers.filter(p => !subscription || (tools.find(t => t.id === tool)?.providers || []).includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}</form.Field>}</form.Subscribe>
    <form.Field name="value">{field => subscription ? <>
      <label>Token file<input type="file" accept=".json,application/json" onChange={async e => { const file = e.target.files?.[0]; if (file) field.handleChange(await file.text()); e.target.value = ''; }} /></label>
      <label>Or paste the file’s contents<textarea rows={5} value={field.state.value} onChange={e => field.handleChange(e.target.value)} spellCheck={false} autoComplete="off" placeholder="{ … }" /></label>
      <p className="field-help">For example <code>~/.codex/auth.json</code> or <code>~/.claude/.credentials.json</code>. Up to 64 KiB of JSON.</p></>
      : <><label>API key<input type="password" required value={field.state.value} onChange={e => field.handleChange(e.target.value)} autoComplete="off" spellCheck={false} /></label>
        <p className="field-help">Golf keeps only the sealed value and its last four characters. Provider calls go through the private AI Gateway; the key is added to each outbound request and never logged.</p></>}</form.Field>
    {target.scope === 'installation' ? <form.Field name="shareEveryone">{field => <label className="policy-choice"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} /><span><strong>Everyone on this installation may use it</strong><small>Through engines that use it. You can narrow this later under Share.</small></span></label>}</form.Field> : null}
    {target.scope === 'organization' ? <form.Field name="shareOrganization">{field => <label className="policy-choice"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} /><span><strong>Members of {target.organization} may use it in its repositories</strong><small>Through engines that use it. You can change this later under Share.</small></span></label>}</form.Field> : null}
    {subscription ? <form.Field name="acceptTerms">{field => <label className="policy-choice"><input type="checkbox" checked={field.state.value} onChange={e => field.handleChange(e.target.checked)} /><span><strong>I checked my provider’s terms for this sign-in</strong><small>Required to store a subscription sign-in.</small></span></label>}</form.Field> : null}
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, !state.values.label.trim() || !state.values.value || subscription && !state.values.acceptTerms] as const}>{([submitting, incomplete]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || incomplete}>{subscription ? 'Seal sign-in' : 'Seal key'}</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

function RotateCredential({ credential, close, done }: { credential: Credential; close: () => void; done: (text: string) => Promise<void> }) {
  const [error, setError] = useState<unknown>();
  const form = useForm({ defaultValues: { value: '' }, onSubmit: async ({ value }) => {
    setError(undefined);
    try { await api('/native/credentials', { action: 'rotate', id: credential.id, expectedVersion: credential.version, value: credential.kind === 'api-key' ? value.value.trim() : value.value }); await done(`${credential.label} was rotated. Calls already running finish with the old value; new calls use the new one.`); }
    catch (e) { setError(e); }
  } });
  return <form className="browser-panel credential-form-content" aria-label={`Rotate ${credential.label}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <h3>Rotate {credential.label}</h3>
    <p className="field-help">Paste the new value. Golf seals it under a new version and destroys the old sealed value. Revoke the old key at {providerLabel(credential.provider)} once nothing uses it.</p>
    <form.Field name="value">{field => credential.kind === 'api-key' ? <label>New API key<input type="password" required value={field.state.value} onChange={e => field.handleChange(e.target.value)} autoComplete="off" spellCheck={false} /></label>
      : <label>New token file contents<textarea rows={5} value={field.state.value} onChange={e => field.handleChange(e.target.value)} spellCheck={false} autoComplete="off" /></label>}</form.Field>
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <form.Subscribe selector={state => [state.isSubmitting, !state.values.value] as const}>{([submitting, empty]) => <div className="credential-actions">
      <button className="button primary" disabled={submitting || empty}>Rotate</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>}</form.Subscribe>
  </form>;
}

const granteeKinds = (scope: CredentialTarget['scope']) => [['user', 'A person (login)'], ['repository', 'A repository (owner/name)'], ['organization', 'Members of an organization (slug)'], ...(scope === 'installation' ? [['installation', 'Everyone on this installation']] : [])] as const;
function ShareCredential({ target, credential, places, close, refresh }: { target: CredentialTarget; credential: Credential; places: Place[]; close: () => void; refresh: () => Promise<void> }) {
  const [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const form = useForm({ defaultValues: { granteeKind: 'user' as string, grantee: '', places: [...places] as Place[], engines: '' }, onSubmit: async ({ value, formApi }) => {
    setError(undefined); setNotice('');
    try {
      const engines = value.engines.split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
      await api('/native/credentials', { action: 'grant', id: credential.id, granteeKind: value.granteeKind, ...(value.granteeKind === 'installation' ? {} : { grantee: value.grantee.trim() }), places: value.places, engines });
      setNotice('The grant was saved.'); formApi.reset(); await refresh();
    } catch (e) { setError(e); }
  } });
  const remove = async (grantId: string, grantee: string) => {
    setBusy(true); setError(undefined); setNotice('');
    try { await api('/native/credentials', { action: 'ungrant', id: credential.id, grantId }); setNotice(`${grantee} can no longer use ${credential.label}.`); await refresh(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const grants = credential.grants || [];
  return <section className="browser-panel credential-form-content" aria-label={`Share ${credential.label}`}>
    <h3>Who may use {credential.label}</h3>
    <p className="field-help">{target.scope === 'user' ? 'Only you can use it unless you add a grant. ' : ''}A grant lets people use this credential through engines, never read it. Limit it to engines and places; removing a grant takes effect at the next call.</p>
    {grants.length ? <ul className="policy-list">{grants.map(grant => <li key={grant.id} className="policy-row"><div className="policy-row-main"><div className="policy-row-title"><h4>{grant.grantee}</h4></div>
      <p className="policy-row-detail">{grant.places.map(place => placeLabels[place]).join(', ')} · {grant.engines.length ? `engines ${grant.engines.join(', ')}` : 'any engine that uses it'}</p></div>
      <button type="button" className="button secondary danger-action" disabled={busy} aria-label={`Stop sharing with ${grant.grantee}`} onClick={() => void remove(grant.id, grant.grantee)}>Remove</button></li>)}</ul> : <p className="field-help">Not shared.</p>}
    <form aria-label={`Add a grant to ${credential.label}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="granteeKind">{field => <label>Share with<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>{granteeKinds(target.scope).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}</form.Field>
      <form.Subscribe selector={state => state.values.granteeKind}>{kind => kind === 'installation' ? null : <form.Field name="grantee">{field => <label>{kind === 'user' ? 'Login' : kind === 'repository' ? 'Repository' : 'Organization'}<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder={kind === 'user' ? 'login' : kind === 'repository' ? 'owner/name' : 'organization'} autoComplete="off" /></label>}</form.Field>}</form.Subscribe>
      <form.Field name="places">{field => <fieldset className="policy-choices"><legend>Where</legend>{places.map(place => <label key={place} className="policy-choice"><input type="checkbox" checked={field.state.value.includes(place)} onChange={e => field.handleChange(e.target.checked ? [...field.state.value, place] : field.state.value.filter(item => item !== place))} /><span><strong>{placeLabels[place]}</strong></span></label>)}</fieldset>}</form.Field>
      <form.Field name="engines">{field => <label>Only these engine ids (optional)<input value={field.state.value} onChange={e => field.handleChange(e.target.value)} placeholder="Empty: any engine that uses it" autoComplete="off" /></label>}</form.Field>
      {notice ? <p className="field-help" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{message(error)}</p> : null}
      <form.Subscribe selector={state => [state.isSubmitting, state.values.granteeKind !== 'installation' && !state.values.grantee.trim() || !state.values.places.length] as const}>{([submitting, incomplete]) => <div className="credential-actions">
        <button className="button primary" disabled={submitting || incomplete}>Add grant</button><button type="button" className="button secondary" onClick={close}>Done</button></div>}</form.Subscribe>
    </form>
  </section>;
}
