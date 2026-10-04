import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link2, LoaderCircle, Plus, RefreshCw, Unlink, Users, X } from 'lucide-react';
import { errorMessage, repositoryTeamAccessClient } from './api';
import { TeamPermission, TeamVisibility, type RepositoryAccess, type RepositoryTeamAccess as TeamAccess, type User } from './gen/golf/v1/golf_pb';
import { DataTable, type DataTableColumn } from './DataTable';
import { Loading, More, PanelError, privateQuery } from './RepositoryUI';

type Target = { repositoryId: string; ownerId: string; expectedRevision: string };
type Intent = { target: Target; row: TeamAccess };
const id = (value: string) => value.length <= 19 && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9223372036854775807n;
const revision = (value: string) => /^[0-9a-f]{64}$/.test(value);
const permissions = [TeamPermission.NONE, TeamPermission.READ, TeamPermission.WRITE, TeamPermission.ADMIN, TeamPermission.OWNER];
const units = ['repo.code', 'repo.issues', 'repo.ext_issues', 'repo.pulls', 'repo.releases', 'repo.wiki', 'repo.ext_wiki', 'repo.projects', 'repo.packages', 'repo.actions'];
const permissionName = (value: TeamPermission) => ({ [TeamPermission.UNSPECIFIED]: 'Unknown', [TeamPermission.NONE]: 'None', [TeamPermission.READ]: 'Read', [TeamPermission.WRITE]: 'Write', [TeamPermission.ADMIN]: 'Admin', [TeamPermission.OWNER]: 'Owner' })[value] || 'Unknown';
function teamConfiguration(row: TeamAccess) {
  const team = row.team;
  return JSON.stringify(team && [team.id, team.name, team.description, team.permission, Object.entries(team.unitPermissions).sort(([a], [b]) => a.localeCompare(b)), team.includesAllRepositories, team.visibility]);
}
function validRow(row: TeamAccess, manage: boolean) {
  const team = row.team;
  if (!team || !id(team.id) || !team.name.trim() || new TextEncoder().encode(team.name).length > 255 || /\p{Cc}/u.test(team.name) || new TextEncoder().encode(team.description).length > 2048 || !permissions.includes(team.permission) || ![TeamVisibility.PUBLIC, TeamVisibility.LIMITED, TeamVisibility.PRIVATE].includes(team.visibility) || !revision(row.revision) || Object.entries(team.unitPermissions).some(([unit, permission]) => !units.includes(unit) || !permissions.includes(permission))) return false;
  const protectedOwner = team.permission === TeamPermission.OWNER || team.name.toLowerCase() === 'owners' || Object.values(team.unitPermissions).includes(TeamPermission.OWNER);
  const protectedGrant = protectedOwner || team.includesAllRepositories;
  return row.isOwnerTeam === protectedOwner && row.canAttach === (manage && !protectedGrant && !row.attached) && row.canDetach === (manage && !protectedGrant && row.attached);
}
function bound(response: { repositoryId: string; ownerId: string; accessRevision: string }, target: Target) {
  if (response.repositoryId !== target.repositoryId || response.ownerId !== target.ownerId || response.accessRevision !== target.expectedRevision) throw new ConnectError('Organization repository identity changed. Refresh access and inspect again.', Code.Internal);
}
function TeamFacts({ row }: { row: TeamAccess }) {
  return <><p className="field-help">Global team permission: <strong>{permissionName(row.team!.permission)}</strong>. This association grants the team access using its existing permissions; it does not change team membership or global permissions.</p><dl className="settings-profile">{Object.entries(row.team!.unitPermissions).sort(([a], [b]) => a.localeCompare(b)).map(([unit, permission]) => <div key={unit}><dt>{unit.replace('repo.', '')}</dt><dd>{permissionName(permission)}</dd></div>)}</dl></>;
}
function Addition({ rows, initial, pending, onSave, onCancel }: { rows: TeamAccess[]; initial: string; pending: boolean; onSave: (row: TeamAccess) => void; onCancel: () => void }) {
  const first = useRef<HTMLSelectElement>(null);
  const form = useForm({ defaultValues: { teamId: initial }, validators: { onSubmit: ({ value }) => rows.some((row) => row.team!.id === value.teamId && row.canAttach) ? undefined : 'Select an eligible team from the loaded organization teams.' }, onSubmit: ({ value }) => { const selected = rows.find((row) => row.team!.id === value.teamId); if (selected?.canAttach) onSave(selected); } });
  useEffect(() => { first.current?.focus(); }, []);
  return <form aria-label="Attach existing organization team" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}><form.Field name="teamId">{(field) => <><label htmlFor="repository-team-selection">Team</label><select ref={first} id="repository-team-selection" value={field.state.value} disabled={pending} onChange={(event) => field.handleChange(event.target.value)} onBlur={field.handleBlur}><option value="">Select a loaded team</option>{rows.filter((row) => row.canAttach).map((row) => <option key={row.team!.id} value={row.team!.id}>{row.team!.name}</option>)}</select></>}</form.Field>
    <form.Subscribe selector={(state) => state.values.teamId}>{(selected) => { const row = rows.find((value) => value.team!.id === selected); return row ? <TeamFacts row={row} /> : null; }}</form.Subscribe>
    <p className="field-help">Only loaded visible teams are selectable. Load more teams before opening this editor if needed. Owner teams and teams inheriting every repository are managed at organization scope.</p>
    <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button className="button primary" disabled={pending}>{pending ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}Attach team</button><button type="button" className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}
function Removal({ intent, pending, onCancel, onConfirm }: { intent: Intent; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="detach-repository-team-title" onClose={onCancel} onCancel={(event) => { if (pending) event.preventDefault(); }}><div className="dialog-header"><span className="small-icon"><Users size={21} /></span><button className="icon-button" disabled={pending} aria-label="Close team detachment" onClick={onCancel}><X size={19} /></button></div><h2 id="detach-repository-team-title">Detach this team?</h2><p><strong>{intent.row.team!.name}</strong> will lose this repository association. Membership, global team permissions and access granted through other teams or direct grants remain unchanged.</p><div className="dialog-actions"><button ref={cancel} className="button secondary" disabled={pending} onClick={onCancel}>Cancel</button><button className="button session-danger" disabled={pending} onClick={onConfirm}>{pending ? <LoaderCircle className="spin" size={15} /> : <Unlink size={15} />}Confirm detach team</button></div></dialog>;
}
export function RepositoryTeamAccess({ userId, owner, name, access, signingOut, revalidating }: { userId: string; owner: string; name: string; access: RepositoryAccess; signingOut: boolean; revalidating: boolean }) {
  const client = useQueryClient(); const target: Target = { repositoryId: access.repositoryId, ownerId: access.ownerId, expectedRevision: access.revision };
  const scope = JSON.stringify([userId, owner, name, target]); const queryKey = ['repository-team-access', userId, owner, name, target.repositoryId, target.ownerId, target.expectedRevision];
  const enabled = !signingOut && !revalidating && access.organizationOwned && id(userId) && id(target.repositoryId) && id(target.ownerId) && revision(target.expectedRevision);
  const query = useInfiniteQuery({ ...privateQuery, queryKey, enabled, initialPageParam: 1, queryFn: async ({ pageParam, signal }) => {
    const response = await repositoryTeamAccessClient.listRepositoryTeamAccess({ repository: { owner, name }, ...target, page: { page: pageParam, limit: 20 } }, { signal, timeoutMs: 15_000 }); signal.throwIfAborted(); bound(response, target);
    if (!response.page || response.teams.length > 20 || response.canManage && !['owner', 'admin'].includes(access.currentPermission) || response.teams.some((row) => !validRow(row, response.canManage)) || new Set(response.teams.map((row) => row.team!.id)).size !== response.teams.length || response.page.nextPage !== 0 && (response.page.nextPage !== pageParam + 1 || response.page.nextPage > 10_000)) throw new ConnectError('Organization team access metadata is incomplete.', Code.Internal);
    return response;
  }, getNextPageParam: (response) => response.page?.nextPage || undefined });
  const [editor, setEditor] = useState<{ target: Target; initial: string } | null>(null); const [removal, setRemoval] = useState<Intent | null>(null); const [uncertain, setUncertain] = useState(false); const [notice, setNotice] = useState('');
  const identity = JSON.stringify([userId, target.repositoryId, target.ownerId]); const previousIdentity = useRef(identity);
  const alive = useRef(true); const controller = useRef<AbortController | null>(null); const busy = useRef(false); const addButton = useRef<HTMLButtonElement>(null); const previousAction = useRef<HTMLElement | null>(null); const restoreFocus = useRef(false);
  const visible = enabled && query.isSuccess && !query.error && (!query.isFetching || query.isFetchingNextPage);
  const rows = useMemo(() => visible ? query.data!.pages.flatMap((page) => page.teams) : [], [visible, query.data]);
  const duplicate = Boolean(visible && new Set(rows.map((row) => row.team!.id)).size !== rows.length);
  const changedAuthority = Boolean(visible && query.data!.pages.some((page) => page.canManage !== query.data!.pages[0]!.canManage));
  const manage = Boolean(visible && !duplicate && !changedAuthority && query.data!.pages[0]!.canManage);
  const latest = useRef({ scope, enabled, manage, error: query.error }); latest.current = { scope, enabled, manage, error: query.error };
  const active = (frozen = scope) => alive.current && latest.current.scope === frozen && latest.current.enabled && !latest.current.error && client.getQueryData<User | null>(['session'])?.id === userId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); void client.cancelQueries({ queryKey: ['repository-team-access', userId, owner, name] }); client.removeQueries({ queryKey: ['repository-team-access', userId, owner, name] }); }; }, [client, userId, owner, name]);
  useEffect(() => { controller.current?.abort(); setEditor(null); setRemoval(null); setNotice(''); if (previousIdentity.current !== identity) setUncertain(false); previousIdentity.current = identity; }, [scope, identity]);
  useEffect(() => { if (!enabled || query.error || visible && !manage) { if (busy.current) setUncertain(true); controller.current?.abort(); setEditor(null); setRemoval(null); setNotice(''); } }, [enabled, query.error, visible, manage]);
  const mutation = useMutation({ gcTime: 0, retry: false, mutationFn: async (input: { target: Target; row: TeamAccess; attach: boolean; signal: AbortSignal }) => {
    const request = { repository: { owner, name }, ...input.target, teamId: input.row.team!.id, expectedTeamRevision: input.row.revision };
    const response = input.attach ? await repositoryTeamAccessClient.attachRepositoryTeam(request, { signal: input.signal, timeoutMs: 15_000 }) : await repositoryTeamAccessClient.detachRepositoryTeam(request, { signal: input.signal, timeoutMs: 15_000 });
    input.signal.throwIfAborted(); bound(response, input.target);
    if (!response.team || !validRow(response.team, true) || response.team.team!.id !== request.teamId || response.team.attached !== input.attach || response.team.revision === input.row.revision || teamConfiguration(response.team) !== teamConfiguration(input.row)) throw new ConnectError('Team association change could not be confirmed.', Code.Internal);
  } });
  const disabled = !manage || signingOut || busy.current || mutation.isPending || query.isFetching || Boolean(query.error) || uncertain;
  async function dispatch(frozen: Target, row: TeamAccess, attach: boolean) {
    if (disabled || !active() || !latest.current.manage || busy.current || (attach ? !row.canAttach : !row.canDetach)) return;
    busy.current = true; setNotice(''); const abort = new AbortController(); controller.current = abort; const original = scope;
    try { await mutation.mutateAsync({ target: frozen, row, attach, signal: abort.signal }); if (active(original)) { setEditor(null); setRemoval(null); setNotice(attach ? 'Team attached.' : 'Team detached.'); restoreFocus.current = true; await client.invalidateQueries({ queryKey }); } }
    catch { if (active(original)) { setUncertain(true); setEditor(null); setRemoval(null); } }
    finally { busy.current = false; if (controller.current === abort) controller.current = null; }
  }
  async function inspect() { if (mutation.isPending || signingOut || query.isFetching) return; setEditor(null); setRemoval(null); setNotice(''); const original = scope; const result = await query.refetch(); if (!result.isError && active(original)) { setUncertain(false); mutation.reset(); } }
  useEffect(() => { if (restoreFocus.current && !editor && !removal && !mutation.isPending && !query.isFetching && manage && !signingOut) { restoreFocus.current = false; (previousAction.current?.isConnected ? previousAction.current : addButton.current)?.focus(); } }, [editor, removal, mutation.isPending, query.isFetching, manage, signingOut]);
  const columns = useMemo<DataTableColumn<TeamAccess>[]>(() => [
    { id: 'team', header: 'Team', accessorFn: (row) => row.team!.name, cell: ({ row }) => <><strong>{row.original.team!.name}</strong>{row.original.team!.description ? <small>{row.original.team!.description}</small> : null}</> },
    { id: 'association', header: 'Repository access', accessorFn: (row) => row.isOwnerTeam ? 'Owner team' : row.team!.includesAllRepositories ? 'All repositories' : row.attached ? 'Attached' : 'Not attached', cell: ({ row }) => <span className="status-badge">{row.original.isOwnerTeam ? 'Owner team' : row.original.team!.includesAllRepositories ? 'All repositories' : row.original.attached ? 'Attached' : 'Not attached'}</span> },
    { id: 'permission', header: 'Team permission', accessorFn: (row) => permissionName(row.team!.permission), cell: ({ row }) => <>{permissionName(row.original.team!.permission)}<details><summary>Unit permissions</summary><TeamFacts row={row.original} /></details></> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => row.original.canDetach ? <button className="icon-button" aria-label={`Detach team ${row.original.team!.name}`} title="Detach team" disabled={disabled} onClick={(event) => { previousAction.current = event.currentTarget; setEditor(null); setRemoval({ target: { ...target }, row: row.original }); }}><Unlink size={16} /></button> : row.original.canAttach ? <button className="icon-button" aria-label={`Attach team ${row.original.team!.name}`} title="Attach existing team" disabled={disabled} onClick={(event) => { previousAction.current = event.currentTarget; setRemoval(null); setEditor({ target: { ...target }, initial: row.original.team!.id }); }}><Link2 size={16} /></button> : <span className="field-help">{row.original.isOwnerTeam || row.original.team!.includesAllRepositories ? 'Organization managed' : 'View only'}</span> },
  ], [disabled, target.repositoryId, target.ownerId, target.expectedRevision]);
  if (!enabled) return null;
  return <section className="browser-panel credential-list-panel" aria-labelledby="repository-team-access-title"><div className="browser-panel-heading"><h2 id="repository-team-access-title"><Users size={18} />Organization teams</h2><div className="credential-actions"><button className="icon-button" aria-label="Refresh organization team access" title="Refresh organization team access" disabled={mutation.isPending || query.isFetching || signingOut} onClick={() => void inspect()}><RefreshCw size={16} /></button>{manage ? <button ref={addButton} className="button secondary" disabled={disabled || Boolean(editor) || !rows.some((row) => row.canAttach)} onClick={(event) => { previousAction.current = event.currentTarget; setRemoval(null); setNotice(''); setEditor({ target: { ...target }, initial: '' }); }}><Plus size={15} />Attach existing team</button> : null}</div></div>
    {query.error ? <PanelError error={query.error} retry={() => void inspect()} /> : duplicate || changedAuthority ? <p role="alert" className="error">Organization team access changed across pages. Refresh and inspect again.</p> : !visible ? <Loading label="Loading organization team access…" /> : <>
      {uncertain ? <div className="panel-error"><h3>Team association change could not be confirmed</h3><p role="alert">{mutation.error ? errorMessage(mutation.error) : 'The outcome is unknown.'} No automatic retry was made. Inspect current access before a separate action; refresh does not attribute an uncertain change.</p></div> : null}
      {notice ? <p role="status" className="session-notice">{notice}</p> : null}
      {editor && !uncertain ? <div className="credential-form-content"><h3>Attach existing team</h3><Addition rows={rows} initial={editor.initial} pending={disabled} onSave={(row) => void dispatch(editor.target, row, true)} onCancel={() => { restoreFocus.current = true; setEditor(null); }} /></div> : null}
      <DataTable label="Repository team access" data={rows} columns={columns} getRowId={(row) => row.team!.id} emptyMessage="No teams in the loaded visible organization inventory." />
      <div className="list-footer"><span>{rows.length} loaded visible teams</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetching || mutation.isPending || Boolean(editor)} label="organization teams" load={() => void query.fetchNextPage()} /></div>
      {removal && !uncertain ? <Removal intent={removal} pending={mutation.isPending} onCancel={() => { if (!mutation.isPending) { restoreFocus.current = true; setRemoval(null); } }} onConfirm={() => void dispatch(removal.target, removal.row, false)} /> : null}
    </>}
    <details className="panel-footnote"><summary>About organization team access</summary><p>Global and unit permissions belong to the team, not this repository association or your effective role. Only a current organization owner with repository administrator access may attach or detach existing eligible teams. Owner teams and teams covering all repositories stay managed at organization scope.</p><p>Search and sorting cover loaded visible teams. Grants are observed through supported native APIs; there is no atomic native lock, durable write journal or automatic retry. Invitations, custom roles and broader Access acceptance remain unfinished.</p></details>
  </section>;
}
