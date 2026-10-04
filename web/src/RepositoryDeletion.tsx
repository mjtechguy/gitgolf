import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { LoaderCircle, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { RepositoryLifecycleService, type RepositoryLifecycle, type RepositoryLifecycleOperation, type User } from './gen/golf/v1/golf_pb';
import { Loading, privateQuery } from './RepositoryUI';
import { forgetPrivateQueries } from './queryClient';

export type RepositoryDeletionProps = { client: Client<typeof RepositoryLifecycleService>; userId: string; signingOut: boolean; owner: string; name: string; repositoryId: string; onDeleted?: () => void };
type Intent = { idempotencyKey: string; repositoryId: string; ownerId: string; expectedRevision: string; archived: boolean };
const decimal = (s: string) => /^(0|[1-9][0-9]{0,18})$/.test(s) && BigInt(s) <= 9223372036854775807n;
const identity = (s: string) => decimal(s) && s !== '0';
const revision = (s: string) => /^[a-f0-9]{64}$/.test(s);
const timestamp = (s: string) => s.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s));
const operationKey = (s: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const component = (s: string) => /^[A-Za-z0-9_.-]{1,100}$/.test(s) && s !== '.' && s !== '..';
function validIntent(value: unknown, repositoryId: string): value is Intent {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const v = value as Intent;
 return Object.keys(v).sort().join(',') === 'archived,expectedRevision,idempotencyKey,ownerId,repositoryId' && operationKey(v.idempotencyKey || '') && v.repositoryId === repositoryId && identity(v.repositoryId) && identity(v.ownerId || '') && revision(v.expectedRevision || '') && typeof v.archived === 'boolean';
}
function validObservation(v: RepositoryLifecycle | undefined, p: RepositoryDeletionProps): v is RepositoryLifecycle {
 return Boolean(v && v.repository?.owner === p.owner && v.repository.name === p.name && v.repositoryId === p.repositoryId && identity(v.ownerId) && revision(v.revision) && (!v.canManage || (!v.stepUpAvailable && v.activeWorkCount === '' || v.stepUpAvailable && decimal(v.activeWorkCount))) && (!v.deleteAvailable || v.canManage && v.stepUpAvailable && v.activeWorkCount === '0' && !v.mirror && !v.unresolved && !v.blockedReason && !v.deleteNotice));
}
function validOperation(v: RepositoryLifecycleOperation | undefined, intent: Intent, p: RepositoryDeletionProps): v is RepositoryLifecycleOperation {
 return Boolean(v && v.action === 'delete' && v.idempotencyKey === intent.idempotencyKey && v.repository?.owner === p.owner && v.repository.name === p.name && v.repositoryId === intent.repositoryId && v.ownerId === intent.ownerId && v.actorId === p.userId && v.expectedRevision === intent.expectedRevision && v.fromArchived === intent.archived && v.toArchived === intent.archived && ['RESERVED', 'DISPATCH_UNKNOWN', 'SUCCEEDED', 'REJECTED'].includes(v.phase) && v.failureCode === (v.phase === 'REJECTED' ? 'preflight_refused' : '') && timestamp(v.createdAt) && timestamp(v.updatedAt) && Date.parse(v.updatedAt) >= Date.parse(v.createdAt));
}
function stored(key: string, repositoryId: string) {
 try {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return { intent: null as Intent | null, blocked: false };
  const value: unknown = JSON.parse(raw);
  return validIntent(value, repositoryId) ? { intent: value, blocked: false } : { intent: null, blocked: true };
 } catch { return { intent: null, blocked: true }; }
}
function Confirmation({ fullName, pending, error, onCancel, onConfirm }: { fullName: string; pending: boolean; error: string; onCancel: () => void; onConfirm: (name: string, password: string) => void }) {
 const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), title = useId(), nameId = useId(), passwordId = useId();
 const form = useForm({ defaultValues: { name: '', password: '' }, validators: { onSubmit: ({ value }) => value.name !== fullName || !value.password ? 'Enter the exact full repository name and your current Golf password.' : undefined }, onSubmit: ({ value }) => { onConfirm(value.name, value.password); form.setFieldValue('password', ''); } });
 useEffect(() => { const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; dialog.current?.showModal(); cancel.current?.focus(); return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus(); }; }, []);
 return <dialog ref={dialog} className="create-dialog" aria-labelledby={title} onCancel={event => { if (pending) event.preventDefault(); else onCancel(); }}>
  <h2 id={title}>Delete this repository?</h2><p>This permanently deletes <strong>{fullName}</strong>. Code and native repository data cannot be restored through this action. Golf retains the original operation record.</p>
  <form aria-label="Confirm repository deletion" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
   <form.Field name="name">{field => <><label htmlFor={nameId}>Full repository name</label><input id={nameId} value={field.state.value} disabled={pending} autoComplete="off" onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
   <form.Field name="password">{field => <><label htmlFor={passwordId}>Current Golf password</label><input id={passwordId} type="password" autoComplete="current-password" value={field.state.value} disabled={pending} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
   <form.Subscribe selector={state => state.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
   {error ? <p className="error" role="alert">{error}</p> : null}
   <div className="dialog-actions"><button ref={cancel} className="button secondary" type="button" disabled={pending} onClick={onCancel}>Cancel</button><button className="button session-danger" disabled={pending}>{pending ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}Confirm delete repository</button></div>
  </form>
 </dialog>;
}
export function RepositoryDeletion(props: RepositoryDeletionProps) {
 // Route/account/immutable-ID changes unmount the previous private scope and its
 // requests. Never recycle state for a replacement at the same address.
 return <DeletionScope key={JSON.stringify([props.userId, props.owner, props.name, props.repositoryId])} {...props} />;
}
function DeletionScope(p: RepositoryDeletionProps) {
 const cache = useQueryClient(), storageKey = `golf.deletion-intent.${JSON.stringify([location.origin, p.userId, p.owner, p.name, p.repositoryId])}`;
 const [initial] = useState(() => stored(storageKey, p.repositoryId));
 const [intent, setIntent] = useState<Intent | null>(initial.intent), [storageBlocked, setStorageBlocked] = useState(initial.blocked), [operation, setOperation] = useState<RepositoryLifecycleOperation | null>(null), [editor, setEditor] = useState<RepositoryLifecycle | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false), [denied, setDenied] = useState(false), [correctable, setCorrectable] = useState(false), [rejectedFresh, setRejectedFresh] = useState(false);
 const authorityHidden = useRef(false);
 const inspected = useRef(''), explicitRefresh = useRef(false);
 const alive = useRef(true), busy = useRef(false), request = useRef<AbortController | null>(null), signingOut = useRef(p.signingOut), notified = useRef('');
 signingOut.current = p.signingOut;
 const targetValid = identity(p.userId) && identity(p.repositoryId) && component(p.owner) && component(p.name);
 const queryKey = ['repository-deletion', p.userId, p.owner, p.name, p.repositoryId];
 const query = useQuery({ ...privateQuery, retry: false, enabled: targetValid && !p.signingOut && !denied, queryKey, queryFn: async ({ signal }) => {
  let response;
  try { response = await p.client.getRepositoryLifecycle({ repository: { owner: p.owner, name: p.name }, repositoryId: p.repositoryId }, { signal, timeoutMs: 15_000 }); signal.throwIfAborted(); }
  catch (value) { if ([Code.PermissionDenied, Code.Unauthenticated].includes(ConnectError.from(value).code)) authorityHidden.current = true; throw value; }
  if (!validObservation(response.lifecycle, p)) throw new ConnectError('Repository deletion observation could not be verified.', Code.Internal);
  if (!response.lifecycle.canManage) authorityHidden.current = true;
  return response.lifecycle;
 } });
 const current = !p.signingOut && !denied && !query.isFetching && !query.error ? query.data : undefined;
 const active = () => alive.current && !signingOut.current && !authorityHidden.current && cache.getQueryData<User | null>(['session'])?.id === p.userId;
 function deny(value: unknown) {
  const e = ConnectError.from(value);
  if (!alive.current || signingOut.current) return;
  if (e.code === Code.Unauthenticated && cache.getQueryData<User | null>(['session'])?.id === p.userId) { cache.setQueryData(['session'], null); forgetPrivateQueries(cache); }
  hide();
 }
 function hide() { authorityHidden.current = true; setDenied(true); setEditor(null); setOperation(null); setError('Current ownership or sign-in is unavailable. Inspect again after it is restored.'); request.current?.abort(); void cache.cancelQueries({ queryKey, exact: true }); cache.removeQueries({ queryKey, exact: true }); }
 useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); void cache.cancelQueries({ queryKey, exact: true }); cache.removeQueries({ queryKey, exact: true }); }; }, []);
 useEffect(() => { if (p.signingOut) { request.current?.abort(); setEditor(null); setOperation(null); setError(''); } }, [p.signingOut]);
 useEffect(() => {
  if (query.isFetching) { inspected.current = ''; setEditor(null); setOperation(null); setCorrectable(false); setRejectedFresh(false); }
  if (query.error instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(query.error.code)) deny(query.error);
  if (current && !current.canManage) hide();
 }, [query.isFetching, query.error, current?.canManage]);
 async function inspect(original: Intent, freshAvailability = false) {
  if (busy.current || !active()) return;
  busy.current = true; setPending(true); setEditor(null); setOperation(null); setError(''); setCorrectable(false);
  const abort = new AbortController(); request.current = abort;
  try {
   const response = await p.client.getRepositoryDeletionOperation({ repository: { owner: p.owner, name: p.name }, repositoryId: original.repositoryId, ownerId: original.ownerId, idempotencyKey: original.idempotencyKey }, { signal: abort.signal, timeoutMs: 15_000 }); abort.signal.throwIfAborted();
   if (!validOperation(response.operation, original, p)) throw new ConnectError('Original deletion receipt could not be verified.', Code.Internal);
   if (active()) { setRejectedFresh(response.operation.phase === 'REJECTED' && freshAvailability); setOperation(response.operation); if (response.operation.phase === 'SUCCEEDED' && notified.current !== original.idempotencyKey) { notified.current = original.idempotencyKey; p.onDeleted?.(); } }
  } catch (value) {
   if (active()) { const e = ConnectError.from(value); setError('The original deletion outcome is unconfirmed. Inspect its original operation; do not resend or create a replacement operation.'); if ([Code.Unauthenticated, Code.PermissionDenied].includes(e.code)) deny(e); }
  } finally { busy.current = false; if (alive.current) setPending(false); if (request.current === abort) request.current = null; }
 }
 useEffect(() => { if (intent && targetValid && !p.signingOut && !denied && !query.isFetching && inspected.current !== intent.idempotencyKey) { inspected.current = intent.idempotencyKey; void inspect(intent, explicitRefresh.current && !query.error && Boolean(query.data?.canManage)); } }, [intent, targetValid, p.signingOut, denied, query.isFetching]);
 const intentTerminal = operation?.phase === 'REJECTED';
 const canCorrect = correctable && intent && current?.revision === intent.expectedRevision && current.ownerId === intent.ownerId && current.archived === intent.archived;
 const available = Boolean(current?.deleteAvailable && current.canManage && current.stepUpAvailable && !current.unresolved && current.activeWorkCount === '0' && !current.mirror && !current.blockedReason && !pending && !storageBlocked && (!intent || intentTerminal && rejectedFresh || canCorrect));
 async function submit(fullName: string, password: string) {
  if (!editor || !current || busy.current || !active() || !available || fullName !== `${p.owner}/${p.name}` || !password) return;
  if (editor.revision !== current.revision || editor.ownerId !== current.ownerId || editor.archived !== current.archived) { setError('Current values changed. Cancel and inspect them before a new action.'); return; }
  const original: Intent = canCorrect && intent ? intent : { idempotencyKey: crypto.randomUUID(), repositoryId: p.repositoryId, ownerId: editor.ownerId, expectedRevision: editor.revision, archived: editor.archived };
  try { sessionStorage.setItem(storageKey, JSON.stringify(original)); if (sessionStorage.getItem(storageKey) !== JSON.stringify(original)) throw new Error(); }
  catch { setStorageBlocked(true); setEditor(null); setError('This tab cannot retain the original operation identity. No deletion was requested.'); return; }
  busy.current = true; setPending(true); setIntent(original); setOperation(null); setCorrectable(false); setRejectedFresh(false); setError(''); inspected.current = original.idempotencyKey;
  const abort = new AbortController(); request.current = abort;
  try {
   const response = await p.client.deleteRepository({ repository: { owner: p.owner, name: p.name }, repositoryId: original.repositoryId, ownerId: original.ownerId, expectedRevision: original.expectedRevision, confirmationName: fullName, currentPassword: password, idempotencyKey: original.idempotencyKey }, { signal: abort.signal, timeoutMs: 20_000 }); abort.signal.throwIfAborted();
   if (!validOperation(response.operation, original, p)) throw new ConnectError('Deletion receipt could not be verified.', Code.Internal);
   if (active()) { setRejectedFresh(false); setOperation(response.operation); setEditor(null); if (response.operation.phase === 'SUCCEEDED') { notified.current = original.idempotencyKey; p.onDeleted?.(); } }
  } catch (value) {
   if (active()) {
    const e = ConnectError.from(value), noEffect = e.metadata.get('Golf-Lifecycle-Effect') === 'none';
    if (noEffect) { setCorrectable(true); setError('Your current password was not accepted. No deletion was dispatched. Correct it explicitly.'); }
    else { setEditor(null); setError('The deletion outcome is unconfirmed. Inspect the original operation; do not resend.'); if ([Code.Unauthenticated, Code.PermissionDenied].includes(e.code)) deny(e); }
   }
  } finally { busy.current = false; if (alive.current) setPending(false); if (request.current === abort) request.current = null; }
 }
 async function refresh() {
  if (busy.current || !alive.current || signingOut.current || cache.getQueryData<User | null>(['session'])?.id !== p.userId) return;
  authorityHidden.current = false; explicitRefresh.current = true;
  setEditor(null); setOperation(null); setError(''); setDenied(false); setCorrectable(false);
  const result = await query.refetch();
  if (active() && intent && !([Code.PermissionDenied, Code.Unauthenticated].includes(ConnectError.from(result.error || '').code))) { inspected.current = intent.idempotencyKey; void inspect(intent, !result.error && Boolean(result.data?.canManage)); }
  explicitRefresh.current = false;
 }
 if (p.signingOut) return null;
 const unavailable = !current?.deleteAvailable;
 return <section className="browser-panel" aria-labelledby="repository-deletion-title">
  <div className="browser-panel-heading"><h2 id="repository-deletion-title">Repository deletion</h2><button type="button" className="icon-button" title="Refresh deletion availability" aria-label="Refresh deletion availability" disabled={pending || query.isFetching} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" /></button></div>
  <div className="panel-content page-stack"><p className="field-help">Owner-only deletion with a retained original operation. Transfer is a separate capability.</p>
  {!targetValid ? <p role="alert" className="error">The original repository identity could not be verified.</p> : query.isFetching ? <Loading label="Checking current deletion availability…" /> : denied ? <p role="alert" className="error">Current ownership or sign-in is unavailable.</p> : <>
   {current ? <dl className="detail-grid"><div><dt>Current availability</dt><dd>{current.deleteAvailable ? 'Available' : 'Unavailable'}</dd></div><div><dt>Repository</dt><dd>{p.owner}/{p.name}</dd></div><div><dt>Repository identity</dt><dd>{p.repositoryId}</dd></div><div><dt>Active managed work</dt><dd>{current.activeWorkCount || 'Not observed'}</dd></div></dl> : <p className="field-help">{intent ? 'The repository is unavailable. Its original deletion operation can still be inspected.' : 'Current repository deletion availability could not be verified.'}</p>}
   {unavailable && !intent ? <p className="field-help"><ShieldAlert size={16} aria-hidden="true" />Deletion requires an independently qualified private-native boundary, current ordinary ownership, local password confirmation and no active or unresolved work. This installation has not established deletion availability.</p> : null}
   {storageBlocked ? <p role="alert" className="error">Original deletion metadata is unavailable or invalid. Do not start a replacement operation; inspect the retained server history.</p> : null}
   {available ? <button type="button" className="button session-danger" onClick={() => { setEditor(current!); setError(''); }}><Trash2 size={15} aria-hidden="true" />{canCorrect ? 'Correct deletion password' : 'Delete repository'}</button> : null}
  </>}
  {intent && !denied && !query.isFetching ? <div className="page-stack" aria-label="Original deletion operation"><h3>{operation?.phase === 'SUCCEEDED' ? 'Original deletion completed' : operation?.phase === 'REJECTED' ? 'Original deletion refused before dispatch' : 'Deletion requires inspection'}</h3><p className="field-help">{operation?.phase === 'SUCCEEDED' ? 'Golf verified and recorded the original deletion. A replacement repository is never adopted.' : operation?.phase === 'REJECTED' ? 'Golf recorded a refusal before native dispatch. Refresh current availability before an explicit new request.' : 'The outcome is not confirmed. Keep this original operation identity; no automatic replay or replacement is allowed.'}</p><dl className="detail-grid"><div><dt>Original operation</dt><dd>{intent.idempotencyKey}</dd></div><div><dt>Recorded state</dt><dd>{operation?.phase || 'Unconfirmed'}</dd></div></dl><button type="button" className="button secondary" disabled={pending || query.isFetching} onClick={() => void inspect(intent)}><RefreshCw size={15} aria-hidden="true" />Inspect original deletion operation</button></div> : null}
  {error && !editor && !denied ? <p role="alert" className="error">{error}</p> : null}
  </div>
  {editor && current && !denied && !query.isFetching ? <Confirmation fullName={`${p.owner}/${p.name}`} pending={pending} error={error} onCancel={() => { setEditor(null); setError(''); }} onConfirm={(name, password) => void submit(name, password)} /> : null}
 </section>;
}
