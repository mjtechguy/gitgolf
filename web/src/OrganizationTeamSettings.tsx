import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link } from '@tanstack/react-router';
import { LoaderCircle, Plus, RefreshCw, Users, X } from 'lucide-react';
import { organizationAdminClient, organizationClient, errorMessage } from './api';
import { TeamPermission } from './gen/golf/v1/golf_pb';
import type { GetTeamAdministrationResponse, User } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, More, PanelError, privateQuery } from './RepositoryUI';
import { organizationOptions } from './navigation';

type MemberIntent = { user: User; administration: GetTeamAdministrationResponse };
function RemoveMember({ intent, pending, onClose, onConfirm }: { intent: MemberIntent; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal(); cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="remove-team-member-title" onClose={onClose} onCancel={(event) => { if (pending) event.preventDefault(); }}>
    <div className="dialog-header"><span className="small-icon"><Users size={21} /></span><button className="icon-button" aria-label="Close team member removal" disabled={pending} onClick={onClose}><X size={19} /></button></div>
    <h2 id="remove-team-member-title">Remove this team member?</h2><p>Remove <strong>{intent.user.login}</strong> from {intent.administration.team?.name}. Other team memberships or repository grants may still provide access.</p><p className="field-help">User ID <code>{intent.user.id}</code> · Team ID <code>{intent.administration.team?.id}</code></p>
    <div className="dialog-actions"><button ref={cancel} className="button secondary" disabled={pending} onClick={onClose}>Cancel</button><button className="button session-danger" disabled={pending} onClick={onConfirm}>{pending ? <LoaderCircle size={16} className="spin" /> : null}{pending ? 'Removing…' : 'Confirm remove member'}</button></div>
  </dialog>;
}

export function OrganizationTeamSettings({ userId, organization, teamId, signingOut }: { userId: string; organization: string; teamId: string; signingOut: boolean }) {
  const client = useQueryClient();
  const baseKey = ['organization-team-settings', userId, organization, teamId];
  const administrationQuery = useQuery({ ...privateQuery, queryKey: [...baseKey, 'administration'], queryFn: async ({ signal }) => {
    const response = await organizationAdminClient.getTeamAdministration({ organization, teamId }, { signal, timeoutMs: 8_000 });
    if (!response.team || response.team.id !== teamId || !response.organizationId || !response.revision) throw new ConnectError('Team administration metadata is incomplete. Refresh before continuing.', Code.Internal);
    return response;
  } });
  const administration = administrationQuery.isSuccess && !administrationQuery.isFetching && !signingOut ? administrationQuery.data : undefined;
  const memberKey = [...baseKey, 'members', administration?.organizationId || '', administration?.revision || ''];
  const memberQuery = useInfiniteQuery({ ...privateQuery, queryKey: memberKey, enabled: Boolean(administration), initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => organizationClient.listTeamMembers({ organization, teamId, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 8_000 }),
    getNextPageParam: (response, _pages, page) => { const next = response.page?.nextPage ?? 0; return next > page && next <= 10_000 ? next : undefined; },
  });
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<(MemberIntent & { isMember: boolean }) | null>(null);
  const [confirmation, setConfirmation] = useState<MemberIntent | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const latestSigningOut = useRef(signingOut); latestSigningOut.current = signingOut;
  const writeBusy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const editorVersion = useRef(0);
  const newButton = useRef<HTMLButtonElement>(null);
  const loginInput = useRef<HTMLInputElement>(null);
  const returnToNew = useRef(false);
  const active = () => alive.current && !latestSigningOut.current && client.getQueryData<User | null>(['session'])?.id === userId;
  const error = administrationQuery.error ?? memberQuery.error;
  const loading = administrationQuery.isPending || administrationQuery.isFetching || memberQuery.isPending || (memberQuery.isFetching && !memberQuery.isFetchingNextPage);
  const canManage = Boolean(administration?.canManageMembers && !administration.isOwnerTeam);
  const members = useMemo(() => memberQuery.isSuccess && !error && !loading && !signingOut ? [...new Map(memberQuery.data.pages.flatMap((page) => page.members).map((member) => [member.id, member])).values()] : [], [memberQuery.isSuccess, memberQuery.data, error, loading, signingOut]);
  const resolve = useMutation({ gcTime: 0, retry: false,
    mutationFn: async (input: { login: string; observed: GetTeamAdministrationResponse; version: number }) => {
      const attempt = new AbortController(); controller.current = attempt;
      try {
        const result = await organizationAdminClient.resolveTeamMember({ organization, organizationId: input.observed.organizationId, teamId, userLogin: input.login, expectedRevision: input.observed.revision }, { signal: attempt.signal, timeoutMs: 8_000 });
        if (!result.user?.id || !result.user.login) throw new ConnectError('Member identity could not be confirmed.', Code.Internal);
        return { ...result, attempt };
      } finally { if (controller.current === attempt) controller.current = null; }
    },
    onSuccess: (result, input) => { if (active() && input.version === editorVersion.current && !result.attempt.signal.aborted && !client.getQueryState(memberKey)?.error) setPreview({ user: result.user!, isMember: result.isMember, administration: input.observed }); },
  });
  const write = useMutation({ gcTime: 0, retry: false,
    mutationFn: async (input: MemberIntent & { remove: boolean }) => {
      const attempt = new AbortController(); controller.current = attempt;
      const request = { organization, organizationId: input.administration.organizationId, teamId, userLogin: input.user.login, userId: input.user.id, expectedRevision: input.administration.revision };
      const result = input.remove ? await organizationAdminClient.removeTeamMember(request, { signal: attempt.signal, timeoutMs: 8_000 }) : await organizationAdminClient.addTeamMember(request, { signal: attempt.signal, timeoutMs: 8_000 });
      if (result.user?.id !== input.user.id || result.user.login !== input.user.login || result.isMember !== !input.remove) throw new ConnectError('The membership result could not be confirmed. Refresh and inspect the team.', Code.Internal);
    },
    onSuccess: async (_result, input) => {
      if (!active()) return;
      setConfirmation(null); setPreview(null); setEditing(false); form.reset(); returnToNew.current = true;
      setNotice(input.remove ? 'Team member removed.' : 'Team member added.');
      await client.resetQueries({ queryKey: baseKey });
      await client.invalidateQueries({ queryKey: ['organization', userId, organization] });
    },
    onError: () => { if (active()) { setConfirmation(null); setNotice(''); setUncertain(true); } },
    onSettled: () => { writeBusy.current = false; controller.current = null; },
  });
  const disabled = !canManage || loading || Boolean(error) || uncertain || resolve.isPending || write.isPending || signingOut;
  const form = useForm({ defaultValues: { login: '' }, validators: { onSubmit: ({ value }) => !value.login.trim() || new TextEncoder().encode(value.login.trim()).byteLength > 255 || /\p{Cc}/u.test(value.login) ? 'Enter an existing account username without control characters.' : undefined },
    onSubmit: ({ value }) => { if (disabled || !administration) return; setPreview(null); setNotice(''); resolve.mutate({ login: value.login.trim(), observed: administration, version: editorVersion.current }); },
  });
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    if (error || signingOut || (administration && !canManage)) { controller.current?.abort(); setConfirmation(null); setPreview(null); setEditing(false); form.reset(); editorVersion.current++; }
  }, [error, signingOut, administration?.revision, canManage]);
  useEffect(() => { if (editing && !loading) loginInput.current?.focus(); else if (!editing && returnToNew.current && !loading && !write.isPending) { returnToNew.current = false; newButton.current?.focus(); } }, [editing, loading, write.isPending]);
  function cancelEditor() { if (write.isPending) return; editorVersion.current++; controller.current?.abort(); resolve.reset(); setPreview(null); form.reset(); setEditing(false); returnToNew.current = true; }
  async function refresh() {
    if (writeBusy.current || signingOut) return;
    editorVersion.current++; controller.current?.abort(); setConfirmation(null); setPreview(null); setEditing(false); form.reset(); setNotice(''); resolve.reset();
    await client.resetQueries({ queryKey: baseKey });
    if (active() && !client.getQueryState([...baseKey, 'administration'])?.error) { setUncertain(false); write.reset(); }
  }
  function dispatch(intent: MemberIntent, remove: boolean) { if (writeBusy.current || disabled) return; writeBusy.current = true; setNotice(''); write.mutate({ ...intent, remove }); }
  const columns = useMemo<DataTableColumn<User>[]>(() => [
    { id: 'member', accessorFn: (member) => `${member.login} ${member.id}`, header: 'Member', cell: ({ row }) => <><strong>{row.original.login}</strong><small>User <code>{row.original.id}</code></small></> },
    { accessorKey: 'fullName', header: 'Display name', cell: ({ row }) => row.original.fullName || 'Not set' },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => canManage && administration ? <button className="button secondary" disabled={disabled} aria-label={`Remove member ${row.original.login}`} onClick={() => { write.reset(); setNotice(''); setConfirmation({ user: row.original, administration }); }}>Remove</button> : <span className="muted">View only</span> },
  ], [canManage, administration, disabled, write.reset]);
  return <section aria-labelledby="team-membership-title">
    <header className="repository-intro"><div><span className="eyebrow">{organization}</span><h1 id="team-membership-title"><Users size={29} />Team membership</h1><p>{administration?.team?.name || 'Current team access and membership administration.'}</p></div><Link className="button secondary" {...organizationOptions({ organization, team: teamId })}>Back to team</Link></header>
    <section className="browser-panel credential-list-panel" aria-labelledby="team-members-title"><div className="browser-panel-heading"><h2 id="team-members-title">Members</h2><div className="credential-actions"><button className="button secondary" disabled={administrationQuery.isFetching || memberQuery.isFetching || write.isPending || signingOut} onClick={() => void refresh()}><RefreshCw size={15} />Refresh team members</button>{canManage ? <button ref={newButton} className="button primary" disabled={disabled || editing} onClick={() => { editorVersion.current++; form.reset(); resolve.reset(); setPreview(null); setEditing(true); setNotice(''); }}><Plus size={15} />Add member</button> : null}</div></div>
      {error ? <PanelError error={error} retry={() => void refresh()} /> : loading ? <Loading label="Loading team membership…" /> : administration ? <>
        <p className="panel-footnote">{administration.isOwnerTeam ? 'Owner-team membership is locked in this preview. It requires separate ownership and recovery safeguards.' : canManage ? 'Organization-owner access is verified for every mutation; the Golf instance role does not override it.' : 'View only. Team membership changes require native organization ownership and suitable credential scopes.'}</p>
        {uncertain ? <div className="panel-error"><h3>Membership change could not be confirmed</h3><p role="alert">{write.error ? errorMessage(write.error) : 'The outcome is unknown.'} The change may already have completed. No automatic retry was made; refresh and inspect current membership before starting another change.</p></div> : null}
        {notice ? <p role="status" className="session-notice">{notice}</p> : null}
        {editing && !uncertain && canManage ? <div className="credential-form-content"><h3>Add an existing account</h3><form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}><form.Field name="login">{(field) => <><label htmlFor="team-member-login">Account username</label><input ref={loginInput} id="team-member-login" value={field.state.value} maxLength={255} disabled={disabled} autoComplete="off" onBlur={field.handleBlur} onChange={(event) => { field.handleChange(event.target.value); setPreview(null); resolve.reset(); }} /></>}</form.Field><p className="field-help">Resolve the existing native account before granting team access. This does not invite by email or create an account.</p><form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>{resolve.error ? <p className="error" role="alert">{errorMessage(resolve.error)}</p> : null}<div className="credential-actions"><button type="submit" className="button secondary" disabled={disabled}>{resolve.isPending ? <LoaderCircle size={15} className="spin" /> : null}Resolve member</button><button type="button" className="button secondary" disabled={write.isPending} onClick={cancelEditor}>Cancel</button></div></form>
          {preview ? <section className="credential-uncertain" aria-labelledby="member-access-preview"><h3 id="member-access-preview">Review team access</h3><p><strong>{preview.user.login}</strong> · User ID <code>{preview.user.id}</code></p><p>{preview.isMember ? 'This account is already a member of this team.' : 'Adding this account grants the team’s native repository permissions. Other memberships may combine with these grants.'}</p><dl className="settings-profile"><div><dt>Native team permission</dt><dd>{TeamPermission[preview.administration.team!.permission]?.toLowerCase() || 'Unknown'}</dd></div><div><dt>Repository assignment</dt><dd>{preview.administration.team!.includesAllRepositories ? 'All repositories (native setting)' : 'Explicit team assignments'}</dd></div>{Object.entries(preview.administration.team!.unitPermissions).map(([unit, permission]) => <div key={unit}><dt>{unit}</dt><dd>{TeamPermission[permission]?.toLowerCase() || 'Unknown'}</dd></div>)}</dl><p className="field-help">The reviewed team revision and immutable account ID bind this request. A changed grant or identity requires fresh review. This is stale-form detection, not an atomic native policy lock.</p>{!preview.isMember ? <button className="button primary" disabled={disabled} onClick={() => dispatch(preview, false)}>{write.isPending ? <LoaderCircle size={15} className="spin" /> : null}Add resolved member</button> : null}</section> : null}
        </div> : null}
        <DataTable label="Team members" data={members} columns={columns} getRowId={(member) => member.id} emptyMessage="No visible team members." /><div className="list-footer"><span>{members.length} loaded members</span><More hasMore={Boolean(memberQuery.hasNextPage)} loading={memberQuery.isFetching || write.isPending} label="team members" load={() => void memberQuery.fetchNextPage()} /></div>
        <p className="panel-footnote">Removing one team grant does not prove complete access revocation. Already authorized requests and independent native edits remain outside this operation. No automatic write retry or durable membership mutation journal is provided.</p>
      </> : null}
    </section>
    {confirmation && canManage && !error && !loading ? <RemoveMember intent={confirmation} pending={write.isPending} onClose={() => { if (!write.isPending) setConfirmation(null); }} onConfirm={() => dispatch(confirmation, true)} /> : null}
  </section>;
}
