import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { Copy, KeyRound, LoaderCircle, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { DataTable, type DataTableColumn } from './DataTable';
import { CopyButton, DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { GitCredentialMode as Mode, GitTransportService, type GitCredential, type RepositoryKey } from './gen/golf/v1/golf_pb';

type Target = { repository: RepositoryKey; repositoryId: string; ownerId: string };
type GitClient = Client<typeof GitTransportService>;
const positive = (v: string) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
function validCredential(v: GitCredential, target: Target, native: boolean) {
  return positive(v.id) && v.repositoryId === target.repositoryId && v.ownerId === target.ownerId && (native ? v.identityBound && !v.sourceSessionId && !v.sourceSessionActive : !v.identityBound && positive(v.sourceSessionId)) &&
    [Mode.READ, Mode.WRITE].includes(v.mode) && v.label.trim() === v.label && v.label.length > 0 && new TextEncoder().encode(v.label).length <= 64 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v.label) &&
    Number.isFinite(Date.parse(v.createdAt)) && Number.isFinite(Date.parse(v.expiresAt)) && Date.parse(v.expiresAt) > Date.parse(v.createdAt) && Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= 3600_000 && (!v.revokedAt || Number.isFinite(Date.parse(v.revokedAt)));
}
function sameTarget(v: { repository?: RepositoryKey; repositoryId: string; ownerId: string }, target: Target) {
  return v.repositoryId === target.repositoryId && v.ownerId === target.ownerId && v.repository?.owner === target.repository.owner && v.repository?.name === target.repository.name;
}
function CredentialEditor({ pending, writeAvailable, save, cancel, native }: { native: boolean; pending: boolean; writeAvailable: boolean; save: (v: { label: string; mode: Mode; lifetimeSeconds: number }) => void; cancel: () => void }) {
  const first = useRef<HTMLInputElement>(null);
  const form = useForm({ defaultValues: { label: '', mode: Mode.READ, lifetimeSeconds: 3600 }, validators: { onSubmit: ({ value }) => !value.label || value.label.trim() !== value.label || new TextEncoder().encode(value.label).length > 64 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value.label) ? 'Use a trimmed name of at most 64 bytes.' : undefined }, onSubmit: ({ value }) => save(value) });
  useEffect(() => { first.current?.focus(); }, []);
  return <form aria-label="New Golf Git credential" autoComplete="off" onSubmit={e => { e.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="label">{f => <><label htmlFor="git-credential-name">Name</label><input ref={first} id="git-credential-name" value={f.state.value} disabled={pending} maxLength={64} onChange={e => f.handleChange(e.target.value)} /></>}</form.Field>
    <form.Field name="mode">{f => <><label htmlFor="git-credential-mode">Access</label><select id="git-credential-mode" value={f.state.value} disabled={pending} onChange={e => f.handleChange(Number(e.target.value))}><option value={Mode.READ}>Read · clone and fetch</option><option value={Mode.WRITE} disabled={!writeAvailable}>{native ? 'Write · Git updates under repository rules' : 'Write · unprotected Git updates'}</option></select></>}</form.Field>
    <form.Field name="lifetimeSeconds">{f => <><label htmlFor="git-credential-lifetime">Expires</label><select id="git-credential-lifetime" value={f.state.value} disabled={pending} onChange={e => f.handleChange(Number(e.target.value))}><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={3600}>1 hour</option></select></>}</form.Field>
    <p className="field-help">{native ? 'Scoped to this repository and your current Golf account and repository access. Access sign-out does not revoke it. It expires within an hour; revoke it here when finished. Git clients also need approved Cloudflare Access admission.' : 'Scoped to this repository and your current Golf session. Signing out, revoking the session or disabling the account denies new requests.'} Store it in your Git credential manager; never put it in a remote URL.</p>
    <form.Subscribe selector={s => s.errors}>{errors => errors.length ? <p role="alert" className="error">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}Create Git credential</button><button type="button" className="button secondary" disabled={pending} onClick={cancel}>Cancel</button></div>
  </form>;
}
function RevokeConfirmation({ credential, pending, cancel, confirm }: { credential: GitCredential; pending: boolean; cancel: () => void; confirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { dialog.current?.showModal(); cancelButton.current?.focus(); }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="git-revoke-title" onClose={cancel} onCancel={e => { if (pending) e.preventDefault(); }}><div className="dialog-header"><KeyRound size={20} /><button className="icon-button" aria-label="Close Git credential confirmation" disabled={pending} onClick={cancel}><X size={18} /></button></div><h2 id="git-revoke-title">Revoke this Git credential?</h2><p><strong>{credential.label}</strong> will no longer authorize new Git requests. This does not undo an accepted native push.</p><div className="dialog-actions"><button ref={cancelButton} className="button secondary" disabled={pending} onClick={cancel}>Cancel</button><button className="button session-danger" disabled={pending} onClick={confirm}>{pending ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}Confirm revoke Git credential</button></div></dialog>;
}
export function RepositoryGitTransport({ client, target, userId, signingOut, native = false }: { native?: boolean; client: GitClient; target: Target; userId: string; signingOut: boolean }) {
  const signingOutNow = useRef(signingOut); signingOutNow.current = signingOut;
  const mutationPending = useRef(false);
  const scope = JSON.stringify([userId, target]), generation = useRef(0), mounted = useRef(true), currentScope = useRef(scope); currentScope.current = scope;
  const [editor, setEditor] = useState(false), [revoke, setRevoke] = useState<GitCredential | null>(null), [secret, setSecret] = useState(''), [pending, setPending] = useState(false), [unconfirmed, setUnconfirmed] = useState(false), [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const validTarget = positive(target.repositoryId) && positive(target.ownerId) && Boolean(target.repository.owner && target.repository.name);
  const info = useQuery({ ...privateQuery, queryKey: ['git-transport', scope], enabled: validTarget && !signingOut, queryFn: async ({ signal }) => {
    const r = await client.getGitTransport(target, { signal, timeoutMs: 15_000 });
    if (!sameTarget(r, target) || r.writeCredentialAvailable && !r.readCredentialAvailable || r.readCredentialAvailable && !r.enabled || r.enabled && r.cloneUrl !== `${new URL(r.cloneUrl).origin}/git/${target.repository.owner}/${target.repository.name}.git`) throw new ConnectError('Git transport identity could not be verified.', Code.Internal);
    const url = r.cloneUrl ? new URL(r.cloneUrl) : undefined;
    if (url && (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || url.search || url.hash)) throw new ConnectError('Git clone address could not be verified.', Code.Internal);
    return r;
  } });
  const ready = !signingOut && info.isSuccess && !info.isFetching ? info.data : undefined;
  const inventory = useInfiniteQuery({ ...privateQuery, queryKey: ['git-credentials', scope], enabled: Boolean(ready), initialPageParam: 1, queryFn: async ({ pageParam, signal }) => {
    const r = await client.listGitCredentials({ ...target, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 15_000 });
    if (!r.page || r.credentials.length > 20 || r.credentials.some(v => !validCredential(v, target, native)) || new Set(r.credentials.map(v => v.id)).size !== r.credentials.length || r.page.nextPage !== 0 && r.page.nextPage !== pageParam + 1) throw new ConnectError('Git credential inventory could not be verified.', Code.Internal);
    return r;
  }, getNextPageParam: r => r.page?.nextPage || undefined });
  const clear = () => { controller.current?.abort(); generation.current++; mutationPending.current = false; setEditor(false); setRevoke(null); setSecret(''); setNotice(''); setPending(false); };
  useEffect(() => { clear(); setUnconfirmed(false); }, [scope, signingOut]);
  useEffect(() => { if (!ready || inventory.isError) clear(); }, [Boolean(ready), inventory.isError]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const alive = (g: number, frozen: string) => mounted.current && !signingOutNow.current && generation.current === g && currentScope.current === frozen;
  const loaded = inventory.data?.pages.flatMap(p => p.credentials) || [];
  const invalidInventory = loaded.length > 2000 || new Set(loaded.map(v => v.id)).size !== loaded.length;
  const busy = invalidInventory || inventory.isError || pending || unconfirmed || !ready || inventory.isFetching;
  async function refresh() { clear(); setUnconfirmed(false); await info.refetch(); await inventory.refetch(); }
  async function create(v: { label: string; mode: Mode; lifetimeSeconds: number }) {
    if (mutationPending.current || busy || !ready?.readCredentialAvailable || v.mode === Mode.WRITE && !ready.writeCredentialAvailable) return;
    const g = generation.current, frozen = scope, abort = new AbortController(); controller.current = abort; mutationPending.current = true; setPending(true); setSecret('');
    try { const r = await client.createGitCredential({ ...target, ...v }, { signal: abort.signal, timeoutMs: 15_000 }); if (!r.credential || !validCredential(r.credential, target, native) || r.credential.label !== v.label || r.credential.mode !== v.mode || !(native ? r.credential.sourceIdentityActive : r.credential.sourceSessionActive) || !/^golf_git_[A-Za-z0-9_-]{43}$/.test(r.secret)) throw new Error('Invalid Git credential receipt'); if (alive(g, frozen)) { setEditor(false); setSecret(r.secret); setNotice(native ? 'Copy this Git credential now. It is shown once. Revoke it here when finished; Access sign-out does not revoke it.' : 'Copy this Git credential now. It is shown once and expires with its source session.'); void inventory.refetch(); } }
    catch { if (alive(g, frozen)) { setEditor(false); setUnconfirmed(true); setNotice('Creation was not confirmed. Refresh and inspect your credential inventory before creating another. The secret cannot be recovered.'); } }
    finally { if (alive(g, frozen)) { mutationPending.current = false; setPending(false); } }
  }
  async function remove() {
    if (mutationPending.current || busy || !revoke) return; const id = revoke.id, g = generation.current, frozen = scope, abort = new AbortController(); controller.current = abort; mutationPending.current = true; setPending(true);
    try { const r = await client.revokeGitCredential({ ...target, credentialId: id }, { signal: abort.signal, timeoutMs: 15_000 }); if (r.credentialId !== id || !r.revoked) throw new Error('Invalid revocation receipt'); if (alive(g, frozen)) { setRevoke(null); setSecret(''); setNotice('Git credential revoked for new requests.'); void inventory.refetch(); } }
    catch { if (alive(g, frozen)) { setRevoke(null); setUnconfirmed(true); setNotice('Revocation was not confirmed. Refresh and inspect the original credential; do not retry blindly.'); } }
    finally { if (alive(g, frozen)) { mutationPending.current = false; setPending(false); } }
  }
  const rows = ready && !inventory.isError && !inventory.isFetching && !invalidInventory ? loaded : [];
  const columns: DataTableColumn<GitCredential>[] = [
    { id: 'label', header: 'Name', accessorFn: v => v.label },
    { id: 'access', header: 'Access', accessorFn: v => v.mode === Mode.READ ? 'Read' : native ? 'Write under repository rules' : 'Unprotected write' },
    { id: 'state', header: 'State', accessorFn: v => v.revokedAt ? 'Revoked' : !(native ? v.sourceIdentityActive : v.sourceSessionActive) ? native ? 'Access changed' : 'Session ended' : Date.parse(v.expiresAt) <= Date.now() ? 'Expired' : 'Active' },
    { id: 'expires', header: 'Expires', accessorFn: v => v.expiresAt, cell: ({ row }) => <DateLabel value={row.original.expiresAt} /> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <button className="icon-button" title="Revoke credential" aria-label={`Revoke Git credential ${row.original.label}`} disabled={busy || Boolean(row.original.revokedAt)} onClick={() => { setSecret(''); setEditor(false); setRevoke(row.original); }}><Trash2 size={16} /></button> },
  ];
  return <section className="settings-section" aria-labelledby="git-transport-title"><div className="section-heading"><div><h2 id="git-transport-title">Golf Git credentials</h2><p className="field-help">{native ? 'Short-lived HTTPS Git access scoped to this repository and your Golf account.' : 'Short-lived HTTP Git access scoped to this repository and your Golf session.'}</p></div><div className="row-actions"><button className="icon-button" aria-label="Refresh Git transport and credentials" title="Refresh" disabled={pending || info.isFetching || inventory.isFetching} onClick={() => void refresh()}><RefreshCw size={16} /></button><button className="button secondary" disabled={busy || !ready?.readCredentialAvailable} onClick={() => { setSecret(''); setNotice(''); setEditor(true); }}><Plus size={16} />New Git credential</button></div></div>
    {info.isPending && !signingOut ? <Loading label="Reading Git transport…" /> : info.isError ? <PanelError error={info.error} retry={() => void refresh()} /> : null}
    {ready ? <><p className="field-help">{ready.enabled ? <><span className="copy-field clone-address"><label htmlFor="git-clone-address">Clone address</label><input id="git-clone-address" readOnly value={ready.cloneUrl} onFocus={event => event.currentTarget.select()} /><CopyButton text={ready.cloneUrl} label="Copy clone address" /></span></> : 'Managed HTTP Git is disabled for this deployment.'}</p><p className="organization-guidance">{ready.writeNotice}</p>{notice ? <p role="status" className={unconfirmed ? 'error' : 'field-help'}>{notice}</p> : null}{secret ? <div className="credential-secret"><label htmlFor="git-created-secret">Git credential · username golf</label><input id="git-created-secret" type="password" readOnly value={secret} autoComplete="off" /><button className="button secondary" onClick={() => void navigator.clipboard.writeText(secret).then(() => setNotice("Credential copied. Dismissing it does not clear your clipboard."), () => setNotice("Copy failed. Select and copy the credential manually."))}><Copy size={15} />Copy Git credential</button><button className="button secondary" onClick={() => setSecret('')}>Dismiss secret</button></div> : null}{editor ? <CredentialEditor native={native} pending={pending} writeAvailable={ready.writeCredentialAvailable} save={v => void create(v)} cancel={() => setEditor(false)} /> : null}{inventory.isPending ? <Loading label="Reading Git credentials…" /> : inventory.isError || invalidInventory ? <PanelError error={inventory.error || new ConnectError("Git credential inventory changed across pages. Refresh it before continuing.", Code.FailedPrecondition)} retry={() => void refresh()} /> : <DataTable data={rows} columns={columns} getRowId={v => v.id} label="Golf Git credentials" emptyMessage="No repository-scoped Golf Git credentials." />}{inventory.hasNextPage && !invalidInventory && loaded.length < 2000 ? <button className="button secondary" disabled={inventory.isFetching || pending} onClick={() => void inventory.fetchNextPage()}>Load more Git credentials</button> : null}</> : null}
    {ready && revoke ? <RevokeConfirmation credential={revoke} pending={pending} cancel={() => { if (!pending) setRevoke(null); }} confirm={() => void remove()} /> : null}
  </section>;
}
