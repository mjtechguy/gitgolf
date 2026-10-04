import { RepositoryTeamAccess } from './RepositoryTeamAccess';
import { RepositoryDeployKeys } from './RepositoryDeployKeys';
import { RepositorySettingsLayout } from './AccountSettings';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link } from '@tanstack/react-router';
import { LoaderCircle, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { errorMessage, repositoryAccessClient } from './api';
import type { RepositoryAccess, RepositoryCollaborator, User } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, More, PanelError, privateQuery } from './RepositoryUI';

type Grant = 'read' | 'write' | 'admin';
type Intent = { access: RepositoryAccess; collaborator: RepositoryCollaborator };
function recognizedGrant(value: string): value is Grant { return value === 'read' || value === 'write' || value === 'admin'; }
function RemoveCollaborator({ intent, pending, onClose, onConfirm }: { intent: Intent; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); cancel.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="remove-collaborator-title" onClose={onClose} onCancel={(event) => { if (pending) event.preventDefault(); }}>
    <div className="dialog-header"><span className="small-icon"><ShieldCheck size={21} /></span><button className="icon-button" aria-label="Close collaborator removal" disabled={pending} onClick={onClose}><X size={19} /></button></div>
    <h2 id="remove-collaborator-title">Remove this collaborator?</h2><p>Remove the direct grant for <strong>{intent.collaborator.user?.login}</strong>. Other repository, organization or team grants may still provide access. Already authorized requests are not cancelled.</p><p className="field-help">User <code>{intent.collaborator.user?.id}</code> · Repository <code>{intent.access.repositoryId}</code></p>
    <div className="dialog-actions"><button ref={cancel} className="button secondary" disabled={pending} onClick={onClose}>Cancel</button><button className="button session-danger" disabled={pending} onClick={onConfirm}>{pending ? <LoaderCircle size={15} className="spin" /> : null}{pending ? 'Removing…' : 'Confirm remove collaborator'}</button></div>
  </dialog>;
}
function GrantEditor({ initial, pending, saving, onResolve, onCancel, onChange }: { initial: RepositoryCollaborator | null; pending: boolean; saving: boolean; onResolve: (value: { login: string; permission: string }) => void; onCancel: () => void; onChange: () => void }) {
  const first = useRef<HTMLInputElement>(null); const permissionInput = useRef<HTMLSelectElement>(null);
  const form = useForm({ defaultValues: { login: initial?.user?.login || '', permission: initial && recognizedGrant(initial.permission) ? initial.permission : 'read' }, validators: { onSubmit: ({ value }) => !value.login.trim() || new TextEncoder().encode(value.login.trim()).byteLength > 255 || /\p{Cc}/u.test(value.login) || !recognizedGrant(value.permission) ? 'Choose an existing account username and a supported permission.' : undefined }, onSubmit: ({ value }) => onResolve({ login: value.login.trim(), permission: value.permission }) });
  useEffect(() => { if (initial) permissionInput.current?.focus(); else first.current?.focus(); }, []);
  return <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="login">{(field) => <><label htmlFor="collaborator-login">Account username</label><input ref={first} id="collaborator-login" value={field.state.value} disabled={pending || Boolean(initial)} maxLength={255} autoComplete="off" onBlur={field.handleBlur} onChange={(event) => { field.handleChange(event.target.value); onChange(); }} /></>}</form.Field>
    <form.Field name="permission">{(field) => <><label htmlFor="collaborator-permission">Requested permission</label><select ref={permissionInput} id="collaborator-permission" value={field.state.value} disabled={pending} onBlur={field.handleBlur} onChange={(event) => { field.handleChange(event.target.value as Grant); onChange(); }}><option value="read">Read</option><option value="write">Write</option><option value="admin">Admin</option></select></>}</form.Field>
    <p className="field-help">Choose Read, Write or Admin for this repository. Admin includes destructive operations. Review the account and permission before saving.</p>
    <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button type="submit" className="button secondary" disabled={pending}>{pending ? <LoaderCircle size={15} className="spin" /> : null}Resolve and review access</button><button type="button" className="button secondary" disabled={saving} onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function RepositoryAccessSettings({ userId, owner, name, signingOut }: { userId: string; owner: string; name: string; signingOut: boolean }) {
  const client = useQueryClient(); const baseKey = ['repository-access', userId, owner, name];
  const accessQuery = useQuery({ ...privateQuery, queryKey: [...baseKey, 'access'], queryFn: async ({ signal }) => {
    const response = await repositoryAccessClient.getRepositoryAccess({ repository: { owner, name } }, { signal, timeoutMs: 8_000 });
    if (!response.access?.owner?.id || response.access.owner.id !== response.access.ownerId || !response.access.repositoryId || !response.access.revision) throw new ConnectError('Repository access metadata is incomplete.', Code.Internal);
    return response.access;
  } });
  const access = accessQuery.isSuccess && !accessQuery.isFetching && !signingOut ? accessQuery.data : undefined;
  // Keep only the same validated native target mounted through a parent refresh.
  // Its private content is hidden and reads/writes stop until access is observed again.
  const teamScope = JSON.stringify([userId, owner, name]);
  const teamObservation = useRef<{ scope: string; access: RepositoryAccess } | null>(null);
  if (teamObservation.current?.scope !== teamScope || accessQuery.error || signingOut) teamObservation.current = null;
  if (access) teamObservation.current = { scope: teamScope, access };
  const teamAccess = teamObservation.current?.access;
  const canManage = Boolean(access?.canManage && !access.organizationOwned && (access.currentPermission === 'admin' || (access.currentPermission === 'owner' && access.ownerId === userId)));
  const collaboratorKey = [...baseKey, 'collaborators', access?.repositoryId || '', access?.revision || ''];
  const collaboratorsQuery = useInfiniteQuery({ ...privateQuery, queryKey: collaboratorKey, enabled: Boolean(access && canManage), initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => { const response = await repositoryAccessClient.listRepositoryCollaborators({ repository: { owner, name }, repositoryId: access!.repositoryId, ownerId: access!.ownerId, expectedRevision: access!.revision, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }); if (response.collaborators.some((value) => !value.user?.id || !value.user.login || !value.revision)) throw new ConnectError('Collaborator metadata is incomplete.', Code.Internal); return response; },
    getNextPageParam: (response, _pages, page) => { const next = response.page?.nextPage ?? 0; return next > page && next <= 10_000 ? next : undefined; },
  });
  const [editor, setEditor] = useState<{ access: RepositoryAccess; initial: RepositoryCollaborator | null } | null>(null);
  const [preview, setPreview] = useState<(Intent & { permission: Grant }) | null>(null);
  const [confirmation, setConfirmation] = useState<Intent | null>(null);
  const [uncertain, setUncertain] = useState(false); const [notice, setNotice] = useState('');
  const alive = useRef(true); const latestSigningOut = useRef(signingOut); latestSigningOut.current = signingOut;
  const controller = useRef<AbortController | null>(null); const busy = useRef(false); const editorVersion = useRef(0);
  const newButton = useRef<HTMLButtonElement>(null); const previousAction = useRef<HTMLElement | null>(null); const returnFocus = useRef(false);
  const active = () => alive.current && !latestSigningOut.current && client.getQueryData<User | null>(['session'])?.id === userId;
  const error = accessQuery.error ?? collaboratorsQuery.error;
  const loading = accessQuery.isPending || accessQuery.isFetching || (canManage && (collaboratorsQuery.isPending || (collaboratorsQuery.isFetching && !collaboratorsQuery.isFetchingNextPage)));
  const collaborators = useMemo(() => collaboratorsQuery.isSuccess && !error && !loading && !signingOut ? [...new Map(collaboratorsQuery.data.pages.flatMap((page) => page.collaborators).filter((collaborator) => collaborator.user?.id).map((collaborator) => [collaborator.user!.id, collaborator])).values()] : [], [collaboratorsQuery.isSuccess, collaboratorsQuery.data, error, loading, signingOut]);
  const resolve = useMutation({ gcTime: 0, retry: false,
    mutationFn: async (input: { login: string; permission: Grant; editing: NonNullable<typeof editor>; version: number }) => {
      const attempt = new AbortController(); controller.current = attempt;
      try {
        const response = await repositoryAccessClient.resolveRepositoryCollaborator({ repository: { owner, name }, repositoryId: input.editing.access.repositoryId, ownerId: input.editing.access.ownerId, expectedRevision: input.editing.access.revision, userLogin: input.login }, { signal: attempt.signal, timeoutMs: 8_000 });
        const value = response.collaborator;
        if (!value?.user?.id || !value.user.login || !value.revision) throw new ConnectError('Collaborator identity could not be confirmed.', Code.Internal);
        if (value.user.id === input.editing.access.ownerId || value.user.id === userId || value.permission === 'owner') throw new ConnectError('Owner, self and exceptional owner-level access cannot be changed here.', Code.FailedPrecondition);
        if (input.editing.initial && (value.user.id !== input.editing.initial.user?.id || value.revision !== input.editing.initial.revision)) throw new ConnectError('Collaborator access changed. Refresh and review it again.', Code.FailedPrecondition);
        return { value, attempt };
      } finally { if (controller.current === attempt) controller.current = null; }
    },
    onSuccess: (result, input) => { if (active() && input.version === editorVersion.current && !result.attempt.signal.aborted && !client.getQueryState(collaboratorKey)?.error) setPreview({ access: input.editing.access, collaborator: result.value, permission: input.permission }); },
  });
  const write = useMutation({ gcTime: 0, retry: false,
    mutationFn: async (input: Intent & { permission?: Grant }) => {
      const attempt = new AbortController(); controller.current = attempt;
      const target = input.collaborator.user!;
      const request = { repository: { owner, name }, repositoryId: input.access.repositoryId, ownerId: input.access.ownerId, expectedRevision: input.access.revision, userLogin: target.login, userId: target.id, expectedCollaboratorRevision: input.collaborator.revision };
      const response = input.permission ? await repositoryAccessClient.setRepositoryCollaborator({ ...request, permission: input.permission }, { signal: attempt.signal, timeoutMs: 8_000 }) : await repositoryAccessClient.removeRepositoryCollaborator(request, { signal: attempt.signal, timeoutMs: 8_000 });
      const result = response.collaborator;
      if (result?.user?.id !== target.id || result.user.login !== target.login || !result.revision || (input.permission ? !result.isDirect || result.permission !== input.permission : result.isDirect)) throw new ConnectError('The collaborator change could not be confirmed. Refresh and inspect current access.', Code.Internal);
    },
    onSuccess: async (_result, input) => {
      if (!active()) return; setEditor(null); setPreview(null); setConfirmation(null); returnFocus.current = true; setNotice(input.permission ? 'Collaborator access saved.' : 'Collaborator removed.');
      await client.resetQueries({ queryKey: baseKey }); await client.invalidateQueries({ queryKey: ['repository', userId, owner, name] });
    },
    onError: () => { if (active()) { setConfirmation(null); setNotice(''); setUncertain(true); } },
    onSettled: () => { busy.current = false; controller.current = null; },
  });
  const disabled = !canManage || loading || Boolean(error) || uncertain || resolve.isPending || write.isPending || signingOut;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (error || signingOut || (access && !canManage)) { controller.current?.abort(); setEditor(null); setPreview(null); setConfirmation(null); editorVersion.current++; } }, [error, signingOut, access?.revision, canManage]);
  useEffect(() => { if (!editor && returnFocus.current && !loading && !write.isPending) { returnFocus.current = false; if (previousAction.current?.isConnected) previousAction.current.focus(); else newButton.current?.focus(); } }, [editor, loading, write.isPending]);
  function openEditor(initial: RepositoryCollaborator | null) { if (disabled || !access) return; previousAction.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; editorVersion.current++; resolve.reset(); setPreview(null); setNotice(''); setEditor({ access, initial }); }
  function closeEditor() { if (write.isPending) return; editorVersion.current++; controller.current?.abort(); resolve.reset(); setPreview(null); setEditor(null); returnFocus.current = true; }
  async function refresh() { if (busy.current || signingOut) return; editorVersion.current++; controller.current?.abort(); setEditor(null); setPreview(null); setConfirmation(null); setNotice(''); resolve.reset(); await client.resetQueries({ queryKey: baseKey }); if (active() && !client.getQueryState([...baseKey, 'access'])?.error) { setUncertain(false); write.reset(); } }
  function dispatch(intent: Intent, permission?: Grant) { if (busy.current || disabled) return; busy.current = true; setNotice(''); write.mutate({ ...intent, permission }); }
  const columns = useMemo<DataTableColumn<RepositoryCollaborator>[]>(() => [
    { id: 'account', accessorFn: (collaborator) => `${collaborator.user?.login} ${collaborator.user?.id}`, header: 'Account', cell: ({ row }) => <><strong>{row.original.user?.login}</strong><small>User <code>{row.original.user?.id}</code></small></> },
    { accessorKey: 'permission', header: 'Permission' },
    { id: 'source', accessorFn: (collaborator) => collaborator.isDirect ? 'Direct collaborator' : 'Other repository access', header: 'Grant source', cell: ({ row }) => row.original.user?.id === access?.ownerId ? 'Repository owner · locked' : row.original.isDirect ? 'Direct collaborator' : 'Other access · no direct grant' },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => canManage && access && row.original.user?.id !== access.ownerId && row.original.user?.id !== userId && recognizedGrant(row.original.permission) && row.original.isDirect ? <div className="credential-actions"><button className="icon-button" disabled={disabled} aria-label={`Change access for ${row.original.user?.login}`} title="Change access" onClick={() => openEditor(row.original)}><Pencil size={16} /></button><button className="icon-button" disabled={disabled} aria-label={`Remove collaborator ${row.original.user?.login}`} title="Remove collaborator" onClick={() => { write.reset(); setNotice(''); setConfirmation({ access, collaborator: row.original }); }}><Trash2 size={16} /></button></div> : <span className="muted">{row.original.user?.id === userId ? 'Your own access · locked' : 'View only'}</span> },
  ], [canManage, access, disabled, userId, write.reset]);
  return <RepositorySettingsLayout owner={owner} name={name}><section aria-labelledby="repository-access-title"><header className="repository-intro"><div><span className="eyebrow">{owner}/{name}</span><h1 id="repository-access-title"><ShieldCheck size={29} />Repository access</h1><p>Manage who can access this repository.</p></div><Link className="button secondary" to="/$owner/$name/settings" params={{ owner, name }}>General settings</Link></header>
    <section className="browser-panel credential-list-panel" aria-labelledby="collaborators-title"><div className="browser-panel-heading"><h2 id="collaborators-title">Collaborators</h2><div className="credential-actions"><button className="icon-button" aria-label="Refresh repository access" title="Refresh repository access" disabled={accessQuery.isFetching || collaboratorsQuery.isFetching || write.isPending || signingOut} onClick={() => void refresh()}><RefreshCw size={16} /></button>{canManage ? <button ref={newButton} className="button primary" disabled={disabled || Boolean(editor)} onClick={() => openEditor(null)}><Plus size={15} />Add collaborator</button> : null}</div></div>
      {error ? <PanelError error={error} retry={() => void refresh()} /> : loading ? <Loading label="Loading repository access…" /> : access ? <>
        <div className="credential-form-content"><dl className="settings-profile"><div><dt>Repository owner</dt><dd>{access.owner?.login}</dd></div><div><dt>Your permission</dt><dd>{access.currentPermission}</dd></div></dl></div>
        {uncertain ? <div className="panel-error"><h3>Access change could not be confirmed</h3><p role="alert">{write.error ? errorMessage(write.error) : 'The outcome is unknown.'} The grant may already have changed. No automatic retry was made; refresh and inspect current access before starting a separate change.</p></div> : null}
        {notice ? <p role="status" className="session-notice">{notice}</p> : null}
        {editor && !uncertain && canManage ? <div className="credential-form-content"><h3>{editor.initial ? 'Change collaborator access' : 'Add an existing account'}</h3><GrantEditor initial={editor.initial} pending={disabled} saving={write.isPending} onResolve={(value) => { if (disabled || !recognizedGrant(value.permission)) return; setPreview(null); resolve.mutate({ ...value, permission: value.permission, editing: editor, version: editorVersion.current }); }} onCancel={closeEditor} onChange={() => { setPreview(null); resolve.reset(); }} />{resolve.error ? <p className="error" role="alert">{errorMessage(resolve.error)}</p> : null}
          {preview ? <section className="credential-uncertain" aria-labelledby="collaborator-review-title"><h3 id="collaborator-review-title">Review collaborator access</h3><p><strong>{preview.collaborator.user?.login}</strong> · User <code>{preview.collaborator.user?.id}</code></p><dl className="settings-profile"><div><dt>Current direct grant</dt><dd>{preview.collaborator.isDirect ? preview.collaborator.permission : 'No direct collaborator grant'}</dd></div><div><dt>Requested grant</dt><dd>{preview.permission}</dd></div></dl>{preview.permission === 'admin' ? <p className="organization-guidance">Admin can manage access and delete this repository. Apply only if this account should have that authority.</p> : null}<p className="field-help">Golf checks the reviewed account and access again when you apply. If either changes, refresh and review the grant again.</p><button className="button primary" disabled={disabled} onClick={() => dispatch(preview, preview.permission)}>{write.isPending ? <LoaderCircle size={15} className="spin" /> : null}Apply reviewed access</button></section> : null}
        </div> : null}
        {canManage ? <><DataTable label="Repository collaborators" data={collaborators} columns={columns} getRowId={(collaborator) => collaborator.user!.id} emptyMessage="No direct collaborators in the loaded inventory." /><div className="list-footer"><span>{collaborators.length} loaded collaborators</span><More hasMore={Boolean(collaboratorsQuery.hasNextPage)} loading={collaboratorsQuery.isFetching || write.isPending} label="collaborators" load={() => void collaboratorsQuery.fetchNextPage()} /></div></> : <p className="panel-footnote">Managing collaborators requires administration of a personal repository. Your permission is shown above. Organization and team grants are not managed here.</p>}<details className="panel-footnote"><summary>About repository access</summary><p>This inventory lists direct collaborator grants. Organization, team and other access can be additive and are not listed here. Instance administration does not grant access to this repository.</p><p>Owner and self grants cannot be changed here. Removing a direct grant preserves other permissions and does not cancel already accepted requests. Unconfirmed changes require inspection and are never automatically retried.</p></details>
      </> : null}
    </section>{teamAccess?.organizationOwned ? <RepositoryTeamAccess userId={userId} owner={owner} name={name} access={teamAccess} signingOut={signingOut} revalidating={!access} /> : null}{access && canManage ? <RepositoryDeployKeys userId={userId} owner={owner} name={name} access={access} signingOut={signingOut} /> : null}{confirmation && !error && !loading && canManage ? <RemoveCollaborator intent={confirmation} pending={write.isPending} onClose={() => { if (!write.isPending) setConfirmation(null); }} onConfirm={() => dispatch(confirmation)} /> : null}
  </section></RepositorySettingsLayout>;
}
