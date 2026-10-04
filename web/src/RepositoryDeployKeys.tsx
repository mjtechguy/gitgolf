import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { KeyRound, LoaderCircle, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { errorMessage, repositoryDeployKeyClient } from './api';
import type { RepositoryAccess, RepositoryDeployKey, User } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';

type Target = { repositoryId: string; ownerId: string; expectedRevision: string };
type Addition = { title: string; publicKey: string; readOnly: boolean };
type Intent = { target: Target; key: RepositoryDeployKey };
const id = (value: string) => value.length <= 19 && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9223372036854775807n;
const revision = (value: string) => /^[0-9a-f]{64}$/.test(value);
function validKey(key: RepositoryDeployKey) {
  return id(key.id) && id(key.publicKeyId) && revision(key.revision) && Boolean(key.title.trim()) && new TextEncoder().encode(key.title).length <= 1024 && !/\p{Cc}/u.test(key.title) &&
    Boolean(key.publicKey) && new TextEncoder().encode(key.publicKey).length <= 8192 && !/[\r\n]/.test(key.publicKey) && /^SHA256:[A-Za-z0-9+/]{43}$/.test(key.fingerprint) && Boolean(key.createdAt) && Number.isFinite(Date.parse(key.createdAt));
}
function bound(response: { repositoryId: string; ownerId: string; accessRevision: string }, target: Target) {
  if (response.repositoryId !== target.repositoryId || response.ownerId !== target.ownerId || response.accessRevision !== target.expectedRevision) throw new ConnectError('Deploy-key repository identity changed. Refresh access and inspect again.', Code.Internal);
}
function looksLikePublicKey(value: string) { return /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)[ \t]+[A-Za-z0-9+/]+={0,2}(?:[ \t]+[^\r\n]*)?$/.test(value.trim()); }
function KeyEditor({ pending, onSave, onCancel }: { pending: boolean; onSave: (value: Addition) => void; onCancel: () => void }) {
  const first = useRef<HTMLInputElement>(null);
  const form = useForm({ defaultValues: { title: '', publicKey: '', readOnly: true }, validators: { onSubmit: ({ value }) => !value.title.trim() || new TextEncoder().encode(value.title.trim()).length > 64 || /\p{Cc}/u.test(value.title) || !looksLikePublicKey(value.publicKey) || new TextEncoder().encode(value.publicKey).length > 8192 ? 'Enter a title and one OpenSSH public key. Never paste a private key.' : undefined }, onSubmit: ({ value }) => onSave({ ...value, title: value.title.trim(), publicKey: value.publicKey.trim() }) });
  useEffect(() => { first.current?.focus(); }, []);
  return <form aria-label="Add repository deploy key" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="title">{(field) => <><label htmlFor="deploy-key-title">Title</label><input ref={first} id="deploy-key-title" maxLength={64} autoComplete="off" value={field.state.value} disabled={pending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Field name="publicKey">{(field) => <><label htmlFor="deploy-key-public">Public SSH key</label><textarea id="deploy-key-public" rows={4} maxLength={8192} spellCheck={false} autoComplete="off" value={field.state.value} disabled={pending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Field name="readOnly">{(field) => <><label htmlFor="deploy-key-write"><input id="deploy-key-write" type="checkbox" disabled={pending} checked={!field.state.value} onChange={(event) => field.handleChange(!event.target.checked)} /> Allow write access</label>{!field.state.value ? <p className="organization-guidance">This key can push to this repository within its protection rules. Use read-only access when the integration only needs to clone or fetch.</p> : <p className="field-help">Read-only · clone and fetch this repository.</p>}</>}</form.Field>
    <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button className="button primary" type="submit" disabled={pending}>{pending ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}Add deploy key</button><button className="button secondary" type="button" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}
function Removal({ intent, pending, onCancel, onConfirm }: { intent: Intent; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="remove-deploy-key-title" onClose={onCancel} onCancel={(event) => { if (pending) event.preventDefault(); }}>
    <div className="dialog-header"><span className="small-icon"><KeyRound size={21} /></span><button className="icon-button" disabled={pending} aria-label="Close deploy-key removal" onClick={onCancel}><X size={19} /></button></div>
    <h2 id="remove-deploy-key-title">Remove this deploy key?</h2><p><strong>{intent.key.title}</strong> will lose access to this repository. Other repositories using the same public key keep their own grants. Accepted connections are not cancelled.</p><p className="field-help"><code>{intent.key.fingerprint}</code></p>
    <div className="dialog-actions"><button ref={cancel} className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button><button className="button session-danger" disabled={pending} onClick={onConfirm}>{pending ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}Confirm remove deploy key</button></div>
  </dialog>;
}
export function RepositoryDeployKeys({ userId, owner, name, access, signingOut }: { userId: string; owner: string; name: string; access: RepositoryAccess; signingOut: boolean }) {
  const client = useQueryClient(); const target: Target = { repositoryId: access.repositoryId, ownerId: access.ownerId, expectedRevision: access.revision };
  const queryKey = ['repository-deploy-keys', userId, owner, name, target.repositoryId, target.ownerId, target.expectedRevision];
  const canManage = access.canManage && !access.organizationOwned && (access.currentPermission === 'admin' || (access.currentPermission === 'owner' && access.ownerId === userId));
  const query = useInfiniteQuery({ ...privateQuery, queryKey, enabled: canManage && !signingOut, initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => {
      const response = await repositoryDeployKeyClient.listRepositoryDeployKeys({ repository: { owner, name }, ...target, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 15_000 });
      bound(response, target); if (!response.page || response.keys.length > 20 || response.keys.some((key) => !validKey(key))) throw new ConnectError('Deploy-key metadata is incomplete.', Code.Internal);
      const next = response.page?.nextPage ?? 0; if (next !== 0 && (next !== pageParam + 1 || next > 10_000)) throw new ConnectError('Deploy-key pagination is incomplete.', Code.Internal);
      return response;
    }, getNextPageParam: (response) => response.page?.nextPage || undefined,
  });
  const [editor, setEditor] = useState<Target | null>(null); const [removal, setRemoval] = useState<Intent | null>(null);
  const [uncertain, setUncertain] = useState(false); const [notice, setNotice] = useState('');
  const alive = useRef(true); const latest = useRef({ signingOut, canManage, error: query.error, targetKey: JSON.stringify(target) }); latest.current = { signingOut, canManage, error: query.error, targetKey: JSON.stringify(target) };
  const controller = useRef<AbortController | null>(null); const busy = useRef(false); const addButton = useRef<HTMLButtonElement>(null); const previousAction = useRef<HTMLElement | null>(null); const returnFocus = useRef(false);
  const active = (frozen?: Target) => (!frozen || latest.current.targetKey === JSON.stringify(frozen)) && alive.current && !latest.current.signingOut && latest.current.canManage && !latest.current.error && client.getQueryData<User | null>(['session'])?.id === userId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); client.removeQueries({ queryKey: ['repository-deploy-keys', userId, owner, name] }); }; }, [client, userId, owner, name]);
  useEffect(() => { if (signingOut || !canManage || query.error) { controller.current?.abort(); setEditor(null); setRemoval(null); setNotice(''); } }, [signingOut, canManage, query.error]);
  useEffect(() => { setEditor(null); setRemoval(null); setNotice(''); controller.current?.abort(); }, [access.repositoryId, access.ownerId, access.revision]);
  const keys = useMemo(() => {
    if (!query.isSuccess || query.error || signingOut || !canManage || (query.isFetching && !query.isFetchingNextPage)) return [];
    const rows = query.data.pages.flatMap((page) => page.keys); if (new Set(rows.map((key) => key.id)).size !== rows.length) return [];
    return rows;
  }, [query.data, query.error, query.isSuccess, query.isFetching, query.isFetchingNextPage, signingOut, canManage]);
  const duplicate = Boolean(query.data && new Set(query.data.pages.flatMap((page) => page.keys.map((key) => key.id))).size !== query.data.pages.reduce((total, page) => total + page.keys.length, 0));
  const mutation = useMutation({ retry: false, mutationFn: async (input: { target: Target; addition?: Addition; key?: RepositoryDeployKey; signal: AbortSignal }) => {
    if (input.addition) { const response = await repositoryDeployKeyClient.addRepositoryDeployKey({ repository: { owner, name }, ...input.target, ...input.addition }, { signal: input.signal, timeoutMs: 15_000 }); bound(response, input.target); if (!response.key || !validKey(response.key) || response.key.title !== input.addition.title || response.key.readOnly !== input.addition.readOnly || response.key.publicKey !== input.addition.publicKey.trim().split(/\s+/).slice(0, 2).join(' ')) throw new ConnectError('Added deploy key could not be confirmed.', Code.Internal); }
    else { const response = await repositoryDeployKeyClient.deleteRepositoryDeployKey({ repository: { owner, name }, ...input.target, keyId: input.key!.id, expectedKeyRevision: input.key!.revision }, { signal: input.signal, timeoutMs: 15_000 }); bound(response, input.target); if (response.keyId !== input.key!.id) throw new ConnectError('Deploy-key removal could not be confirmed.', Code.Internal); }
  } });
  useEffect(() => { if (returnFocus.current && !editor && !removal && !mutation.isPending && !query.isFetching && canManage && !signingOut) { returnFocus.current = false; const element = previousAction.current?.isConnected ? previousAction.current : addButton.current; element?.focus(); } }, [editor, removal, mutation.isPending, query.isFetching, canManage, signingOut]);
  const disabled = signingOut || !canManage || busy.current || mutation.isPending || query.isFetching || Boolean(query.error) || duplicate || uncertain;
  async function dispatch(frozen: Target, addition?: Addition, key?: RepositoryDeployKey) {
    if (disabled || !active(frozen) || busy.current) return; busy.current = true; setNotice(''); const abort = new AbortController(); controller.current = abort;
    try { await mutation.mutateAsync({ target: frozen, addition, key, signal: abort.signal }); if (active(frozen)) { setEditor(null); setRemoval(null); setNotice(addition ? 'Deploy key added.' : 'Deploy key removed.'); returnFocus.current = true; await client.invalidateQueries({ queryKey }); } }
    catch { if (alive.current && !latest.current.signingOut && latest.current.targetKey === JSON.stringify(frozen)) { setUncertain(true); setEditor(null); setRemoval(null); } }
    finally { busy.current = false; if (controller.current === abort) controller.current = null; }
  }
  async function inspect() {
    if (mutation.isPending || signingOut || query.isFetching) return; setEditor(null); setRemoval(null); setNotice('');
    const result = await query.refetch(); if (!result.isError && active()) { setUncertain(false); mutation.reset(); }
  }
  const columns = useMemo<DataTableColumn<RepositoryDeployKey>[]>(() => [
    { id: 'title', header: 'Key', accessorFn: (key) => key.title, cell: ({ row }) => <><strong>{row.original.title}</strong><small><code>{row.original.fingerprint}</code></small></> },
    { id: 'access', header: 'Access', accessorFn: (key) => key.readOnly ? 'Read-only' : 'Read/write', cell: ({ row }) => <span className="status-badge">{row.original.readOnly ? 'Read-only' : 'Read/write'}</span> },
    { id: 'created', header: 'Added', accessorFn: (key) => key.createdAt, cell: ({ row }) => <DateLabel value={row.original.createdAt} /> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <button className="icon-button" aria-label={`Remove deploy key ${row.original.title}`} title="Remove deploy key" disabled={disabled} onClick={(event) => { if (disabled || !active()) return; previousAction.current = event.currentTarget; setEditor(null); setRemoval({ target: { ...target }, key: row.original }); }}><Trash2 size={16} /></button> },
  ], [disabled, access.repositoryId, access.ownerId, access.revision]);
  if (!canManage || signingOut) return null;
  return <section className="browser-panel credential-list-panel" aria-labelledby="deploy-keys-title"><div className="browser-panel-heading"><h2 id="deploy-keys-title"><KeyRound size={18} />Deploy keys</h2><div className="credential-actions"><button className="icon-button" aria-label="Refresh deploy keys" title="Refresh deploy keys" disabled={mutation.isPending || query.isFetching || signingOut} onClick={() => void inspect()}><RefreshCw size={16} /></button><button ref={addButton} className="button secondary" disabled={disabled || Boolean(editor)} onClick={(event) => { previousAction.current = event.currentTarget; setRemoval(null); setNotice(''); setEditor({ ...target }); }}><Plus size={15} />Add deploy key</button></div></div>
    {query.error ? <PanelError error={query.error} retry={() => void inspect()} /> : duplicate ? <p className="error" role="alert">Deploy-key inventory changed across pages. Refresh and inspect again.</p> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading deploy keys…" /> : <>
      {uncertain ? <div className="panel-error"><h3>Deploy-key change could not be confirmed</h3><p role="alert">{mutation.error ? errorMessage(mutation.error) : 'The outcome is unknown.'} Inspect current keys before starting a separate change. No automatic retry was made.</p></div> : null}
      {notice ? <p className="session-notice" role="status">{notice}</p> : null}
      {editor && !uncertain ? <div className="credential-form-content"><h3>Add deploy key</h3><KeyEditor pending={disabled} onSave={(value) => void dispatch(editor, value)} onCancel={() => { returnFocus.current = true; setEditor(null); }} /></div> : null}
      <DataTable label="Repository deploy keys" data={keys} columns={columns} getRowId={(key) => key.id} emptyMessage="No deploy keys in the loaded inventory." />
      <div className="list-footer"><span>{keys.length} loaded keys</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetching || mutation.isPending} label="deploy keys" load={() => void query.fetchNextPage()} /></div>
    </>}
    <details className="panel-footnote"><summary>About deploy-key access</summary><p>Public SSH keys grant clone/fetch or read/write access to this repository. Golf stores no private key. A public key can have separate grants on other repositories; removal detaches only this grant. Repository protection still applies. Keys survive browser sign-out and user password changes.</p><p>Refresh observes current grants; it cannot attribute an uncertain write. Changes are checked before and after dispatch, without a native atomic lock or durable mutation journal.</p></details>
    {removal && !query.error && !uncertain ? <Removal intent={removal} pending={mutation.isPending} onCancel={() => { if (!mutation.isPending) { returnFocus.current = true; setRemoval(null); } }} onConfirm={() => void dispatch(removal.target, undefined, removal.key)} /> : null}
  </section>;
}
