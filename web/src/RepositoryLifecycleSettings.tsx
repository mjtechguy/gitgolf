import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { Archive, ArchiveRestore, LoaderCircle, RefreshCw } from 'lucide-react';
import { errorMessage, repositoryClient, repositoryLifecycleClient } from './api';
import type { RepositoryLifecycle, RepositoryLifecycleOperation, User } from './gen/golf/v1/golf_pb';
import { Loading, PanelError, privateQuery } from './RepositoryUI';
import { forgetPrivateQueries } from './queryClient';

type Intent = { idempotencyKey: string; repositoryId: string; ownerId: string; expectedRevision: string; fromArchived: boolean; archived: boolean };
const id = (v: string) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const revision = (v: string) => /^[a-f0-9]{64}$/.test(v);
const key = (v: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const decimal = (v: string) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
function validIntent(v: unknown, repositoryId: string): v is Intent {
  if (!v || typeof v !== 'object') return false;
  const x = v as Intent;
  return key(x.idempotencyKey || '') && x.repositoryId === repositoryId && id(x.repositoryId) && id(x.ownerId || '') && revision(x.expectedRevision || '') && typeof x.fromArchived === 'boolean' && typeof x.archived === 'boolean' && x.fromArchived !== x.archived;
}
function validObservation(v: RepositoryLifecycle | undefined, owner: string, name: string, repositoryId: string): v is RepositoryLifecycle {
  return Boolean(v && v.repository?.owner === owner && v.repository.name === name && v.repositoryId === repositoryId && id(v.ownerId) && revision(v.revision) && (!v.canManage || v.stepUpAvailable && decimal(v.activeWorkCount) || !v.stepUpAvailable && v.activeWorkCount === '') && (!v.archiveAvailable || v.canManage && v.stepUpAvailable && !v.archived && !v.mirror && !v.unresolved && v.activeWorkCount === '0') && (!v.unarchiveAvailable || v.canManage && v.stepUpAvailable && v.archived && !v.mirror && !v.unresolved && v.activeWorkCount === '0'));
}
function validOperation(v: RepositoryLifecycleOperation | undefined, intent: Intent, owner: string, name: string, userId: string): v is RepositoryLifecycleOperation {
  return Boolean(v && v.idempotencyKey === intent.idempotencyKey && v.repositoryId === intent.repositoryId && v.ownerId === intent.ownerId && v.actorId === userId && v.repository?.owner === owner && v.repository.name === name && v.expectedRevision === intent.expectedRevision && v.fromArchived === intent.fromArchived && v.toArchived === intent.archived && ['RESERVED', 'DISPATCH_UNKNOWN', 'SUCCEEDED', 'REJECTED'].includes(v.phase) && v.failureCode === (v.phase === 'REJECTED' ? 'preflight_refused' : '') && Number.isFinite(Date.parse(v.createdAt)) && Number.isFinite(Date.parse(v.updatedAt)));
}
function Confirmation({ frozen, pending, visible, error, onCancel, onConfirm }: { frozen: { observed: RepositoryLifecycle; intent?: Intent }; pending: boolean; visible: boolean; error: string; onCancel: () => void; onConfirm: (password: string, fullName: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const fullName = `${frozen.observed.repository!.owner}/${frozen.observed.repository!.name}`;
  const archived = frozen.intent?.archived ?? !frozen.observed.archived;
  const form = useForm({ defaultValues: { fullName: '', password: '' }, validators: { onSubmit: ({ value }) => value.fullName !== fullName || !value.password ? 'Enter the exact full repository name and your current Golf password.' : undefined }, onSubmit: ({ value }) => { onConfirm(value.password, value.fullName); form.setFieldValue('password', ''); } });
  useEffect(() => { if (visible) { if (!dialog.current?.open) dialog.current?.showModal(); cancel.current?.focus(); } else { dialog.current?.close(); form.setFieldValue('password',''); } }, [visible]);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="repository-archive-confirm-title" onCancel={event => { if (pending) event.preventDefault(); else onCancel(); }}><h2 id="repository-archive-confirm-title">{archived ? 'Archive this repository?' : 'Unarchive this repository?'}</h2><p>{archived ? 'This makes the native repository read only and blocks new Golf-managed work. External Git and native ingress are not atomically fenced by Golf.' : 'This restores native repository writes and permits new Golf-managed work when its other policies allow it.'}</p><p><strong>{fullName}</strong></p>
    <form aria-label="Confirm repository archive state" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="fullName">{field => <><label htmlFor="lifecycle-full-name">Full repository name</label><input id="lifecycle-full-name" value={field.state.value} disabled={pending} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
      <form.Field name="password">{field => <><label htmlFor="lifecycle-password">Current Golf password</label><input id="lifecycle-password" type="password" autoComplete="current-password" value={field.state.value} disabled={pending} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
      <form.Subscribe selector={state => state.errors}>{errors => errors.length ? <p role="alert" className="error">{errors.join(' ')}</p> : null}</form.Subscribe>{error ? <p role="alert" className="error">{error}</p> : null}
      <div className="dialog-actions"><button ref={cancel} type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button><button className="button session-danger" disabled={pending}>{pending ? <LoaderCircle className="spin" size={15} /> : archived ? <Archive size={15} /> : <ArchiveRestore size={15} />}{archived ? 'Confirm archive repository' : 'Confirm unarchive repository'}</button></div>
    </form>
  </dialog>;
}
export function RepositoryLifecycleSettings({ userId, owner, name, repositoryId: suppliedId, signingOut }: { userId: string; owner: string; name: string; repositoryId?: string; signingOut: boolean }) {
  const client = useQueryClient(), alive = useRef(true), request = useRef<AbortController | null>(null), busy = useRef(false);
  const scope = JSON.stringify([userId, owner, name, suppliedId]); const latest = useRef({ scope, signingOut, denied:false,authority:false });
  const [denial, setDenial] = useState<ConnectError | null>(null), [intent, setIntent] = useState<Intent | null>(null), [operation, setOperation] = useState<RepositoryLifecycleOperation | null>(null), [editor, setEditor] = useState<{ observed: RepositoryLifecycle; intent?: Intent } | null>(null), [pending, setPending] = useState(false), [error, setError] = useState(''), [inspectError, setInspectError] = useState(''), [correctable, setCorrectable] = useState(false);
  const captured = useRef<{scope:string; repositoryId?:string}>({scope,repositoryId:suppliedId}); if(captured.current.scope!==scope) captured.current={scope,repositoryId:suppliedId};
  const queryKey = ['repository-lifecycle', userId, owner, name, suppliedId];
  const query = useQuery({ ...privateQuery, enabled: !signingOut && !denial && id(userId), queryKey, queryFn: async ({ signal }) => {
    let repositoryId = suppliedId;
    if (!repositoryId) { const metadata = await repositoryClient.getRepository({ repository: { owner, name } }, { signal, timeoutMs: 8_000 }); signal.throwIfAborted(); if (!metadata.repository || metadata.repository.name !== name || metadata.repository.fullName !== `${owner}/${name}` || !id(metadata.repository.id)) throw new ConnectError('Repository identity could not be verified.', Code.Internal); if(captured.current.scope!==scope) throw new ConnectError('Source selection changed.',Code.Canceled); if(captured.current.repositoryId && captured.current.repositoryId!==metadata.repository.id) throw new ConnectError('Repository identity changed. Inspect its new location separately.',Code.FailedPrecondition); captured.current.repositoryId ||= metadata.repository.id; repositoryId = captured.current.repositoryId; }
    if (!id(repositoryId)) throw new ConnectError('Repository identity could not be verified.', Code.Internal);
    const response = await repositoryLifecycleClient.getRepositoryLifecycle({ repository: { owner, name }, repositoryId }, { signal, timeoutMs: 15_000 }); signal.throwIfAborted(); if (!validObservation(response.lifecycle, owner, name, repositoryId)) throw new ConnectError('Repository lifecycle observation could not be verified.', Code.Internal); return response.lifecycle;
  } });
  const [stateScope,setStateScope]=useState(scope);
  latest.current={scope,signingOut,denied:Boolean(denial || query.error),authority:Boolean(query.data?.canManage)};
  const observed = stateScope===scope && !signingOut && !denial && !query.error && !query.isFetching ? query.data : undefined;
  const storageKey = observed ? `golf.lifecycle-intent.${window.location.origin}:${userId}:${observed.repositoryId}` : undefined;
  const active = (original = scope) => alive.current && latest.current.scope === original && !latest.current.signingOut && !latest.current.denied && latest.current.authority && client.getQueryData<User | null>(['session'])?.id === userId;
  function deny(value: unknown) { if (value instanceof ConnectError && [Code.Unauthenticated, Code.NotFound, Code.PermissionDenied].includes(value.code)) { setDenial(value); setEditor(null); setOperation(null); setError(''); setInspectError(''); request.current?.abort(); void client.cancelQueries({ queryKey, exact: true }); client.removeQueries({ queryKey, exact: true }); if (value.code === Code.Unauthenticated) { client.setQueryData(['session'], null); forgetPrivateQueries(client); } } }
  useEffect(() => { setStateScope(scope); setIntent(null); setOperation(null); setEditor(null); setDenial(null); setError(''); setInspectError(''); setPending(false); setCorrectable(false); alive.current = true; return () => { alive.current = false; request.current?.abort(); void client.cancelQueries({ queryKey, exact: true }); client.removeQueries({ queryKey, exact: true }); }; }, [scope]);
  useEffect(()=>{if(observed && !observed.canManage){setOperation(null);setEditor(null);setError('');request.current?.abort();}},[observed?.canManage]);
  useEffect(() => { if (signingOut || query.error) { setEditor(null); setOperation(null); setError(''); request.current?.abort(); deny(query.error); } }, [signingOut, query.error]);
  useEffect(() => { if (!storageKey || !observed) return; try { const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); if (validIntent(stored, observed.repositoryId)) setIntent(stored); } catch { /* No browser body is persisted. */ } }, [storageKey]);
  async function inspect(original: Intent) {
    if (busy.current || !active() || !observed || observed.ownerId !== original.ownerId) return;
    busy.current = true; setPending(true); setEditor(null); setOperation(null); setInspectError(''); const frozen = scope; const abort = new AbortController(); request.current = abort;
    try { const response = await repositoryLifecycleClient.getRepositoryLifecycleOperation({ repository: { owner, name }, repositoryId: original.repositoryId, ownerId: original.ownerId, idempotencyKey: original.idempotencyKey }, { signal: abort.signal, timeoutMs: 15_000 }); abort.signal.throwIfAborted(); if (!validOperation(response.operation, original, owner, name, userId)) throw new ConnectError('Original operation receipt could not be verified.', Code.Internal); if (active(frozen)) setOperation(response.operation); }
    catch (value) { if (active(frozen)) { setInspectError(errorMessage(ConnectError.from(value))); if (value instanceof ConnectError && value.code !== Code.NotFound) deny(value); } }
    finally { busy.current = false; if (active(frozen)) setPending(false); if (request.current === abort) request.current = null; }
  }
  const inspected = useRef('');
  useEffect(() => { if (intent && observed && !query.isFetching && inspected.current !== intent.idempotencyKey) { inspected.current = intent.idempotencyKey; void inspect(intent); } }, [intent, observed, query.isFetching]);
  async function submit(password: string, fullName: string) {
    if (editor && observed && observed.revision!==editor.observed.revision) { setError('Current values changed. Cancel and inspect them before a new action.'); return; }
    if (!editor || !observed || busy.current || !active() || !observed.canManage || !observed.stepUpAvailable || intent && !correctable && operation?.phase !== 'REJECTED' && operation?.phase !== 'SUCCEEDED') return;
    const original = correctable && intent ? intent : { idempotencyKey: crypto.randomUUID(), repositoryId: observed.repositoryId, ownerId: observed.ownerId, expectedRevision: observed.revision, fromArchived: observed.archived, archived: !observed.archived };
    if (!storageKey) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(original)); } catch { setError('This tab must retain operation identity before dispatch. Enable session storage and try again.'); return; }
    busy.current = true; setPending(true); setIntent(original); setOperation(null); setCorrectable(false); setError(''); setInspectError(''); inspected.current = original.idempotencyKey; const frozen = scope; const abort = new AbortController(); request.current = abort;
    try { const response = await repositoryLifecycleClient.changeRepositoryArchiveState({ repository: { owner, name }, repositoryId: original.repositoryId, ownerId: original.ownerId, expectedRevision: original.expectedRevision, archived: original.archived, confirmationName: fullName, currentPassword: password, idempotencyKey: original.idempotencyKey }, { signal: abort.signal, timeoutMs: 20_000 }); abort.signal.throwIfAborted(); if (!validOperation(response.operation, original, owner, name, userId)) throw new ConnectError('Archive change could not be confirmed. Inspect the original operation.', Code.Internal);
      if (response.lifecycle && (response.operation.phase !== 'SUCCEEDED' || !validObservation(response.lifecycle, owner, name, original.repositoryId) || response.lifecycle.ownerId !== original.ownerId || response.lifecycle.archived !== original.archived)) throw new ConnectError('Archive change could not be confirmed. Inspect the original operation.', Code.Internal);
      if (active(frozen)) { setOperation(response.operation); setEditor(null); if (response.operation.phase === 'SUCCEEDED') await client.invalidateQueries({ queryKey, exact: true }); }
    } catch (value) { if (active(frozen)) { const noEffect = value instanceof ConnectError && value.metadata.get('Golf-Lifecycle-Effect') === 'none'; setError(errorMessage(ConnectError.from(value))); if (noEffect) setCorrectable(true); else { setEditor(null); deny(value); } } }
    finally { busy.current = false; if (active(frozen)) setPending(false); if (request.current === abort) request.current = null; }
  }
  const terminal = operation?.phase === 'REJECTED' || operation?.phase === 'SUCCEEDED';
  const available = observed && !pending && (!intent || terminal || correctable && intent.expectedRevision===observed.revision && intent.ownerId===observed.ownerId && intent.fromArchived===observed.archived) && (observed.archiveAvailable || observed.unarchiveAvailable);
  async function refresh() { if (pending || signingOut) return; setOperation(null); setInspectError(''); setDenial(null); await query.refetch(); if (active() && intent) { inspected.current = ''; } }
  if (signingOut) return null;
  return <section className="browser-panel credential-list-panel" aria-labelledby="repository-lifecycle-title"><div className="browser-panel-heading"><h2 id="repository-lifecycle-title">Archive, transfer and deletion</h2><button className="icon-button" aria-label="Refresh repository lifecycle" title="Refresh repository lifecycle" disabled={pending || query.isFetching} onClick={() => void refresh()}><RefreshCw size={16} /></button></div>
    {denial || query.error ? <PanelError error={denial || query.error!} retry={() => void refresh()} /> : !observed || pending ? <Loading label="Checking repository lifecycle…" /> : <div className="credential-form-content"><dl className="settings-profile"><div><dt>Repository</dt><dd>{owner}/{name}</dd></div><div><dt>Archive state</dt><dd>{observed.archived ? 'Archived · native repository is read only' : 'Active'}</dd></div><div><dt>Golf-managed work</dt><dd>{observed.canManage && observed.stepUpAvailable ? `${observed.activeWorkCount} active or unresolved records` : 'Current owner inspection required'}</dd></div></dl>
      {observed.blockedReason ? <p className="field-help">{({ native_actions_unqualified: 'Native Actions scheduling is unqualified for archive changes. The observed repository unit must be explicitly disabled; this does not attest instance configuration or external ingress.', mirror_unsupported: 'Native mirrors cannot be archived or unarchived.', managed_archive_fence: 'Native archive state changed outside Golf. The retained Golf fence requires qualified reconciliation before new work.', owner_required: 'Only the current native owner with repository administration can manage archive state.', local_password_step_up_required: 'Archive changes require local Golf password step-up. OAuth reauthentication support remains unavailable.', active_work: 'Active or unresolved Golf-managed work must be drained before archiving.', outcome_unresolved: 'An original lifecycle operation is unresolved; inspect it before any new action.' } as Record<string,string>)[observed.blockedReason] || 'Archive changes are currently unavailable.'}</p> : null}
      {intent && observed.canManage && intent.ownerId===observed.ownerId ? <div className="panel-error"><h3>{operation?.phase === 'SUCCEEDED' ? 'Original archive operation completed' : operation?.phase === 'REJECTED' ? 'Original archive operation refused' : 'Archive operation requires inspection'}</h3><p>{operation?.phase === 'SUCCEEDED' ? 'This is a historical verified receipt. Current values above are independently observed.' : operation?.phase === 'REJECTED' ? 'No native dispatch was made for this recorded intent. Inspect current values before a separate new action.' : 'No automatic retry is made. A reserved, unknown or unavailable receipt never permits a new dispatch.'}</p>{inspectError ? <p role="alert" className="error">{inspectError}</p> : null}<button className="button secondary" disabled={pending || !observed.canManage} onClick={() => void inspect(intent)}>Inspect original archive operation</button></div> : null}
      {available ? <button className="button session-danger" onClick={() => { setError(''); setEditor({ observed, intent:correctable && intent ? intent : undefined }); }}>{observed.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}{observed.archived ? 'Unarchive repository' : 'Archive repository'}</button> : null}
      {observed.canManage ? <Link className="button secondary" to="/$owner/$name/settings/deletion" params={{ owner, name }} search={{ repositoryId: observed.repositoryId }}>Deletion availability and original operation</Link> : null}
      <p className="field-help">Namespace transfer remains unavailable. Repository deletion requires an independently qualified deployment boundary and recovery safeguards.</p>
    </div>}
    {editor && !query.error && !denial ? <Confirmation frozen={editor} pending={pending} visible={Boolean(observed && observed.canManage && !query.error && !denial)} error={observed && observed.revision!==editor.observed.revision ? 'Current values changed. Your unsent confirmation is retained; cancel and inspect them before a new action.' : error} onCancel={() => setEditor(null)} onConfirm={(password, fullName) => void submit(password, fullName)} /> : null}
  </section>;
}
