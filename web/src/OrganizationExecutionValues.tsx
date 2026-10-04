import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { Check, KeyRound, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { isRunID } from './navigation';
import { OrganizationExecutionValueService, RepositoryExecutionValueKind as Kind, type OrganizationExecutionValue as Item, type OrganizationExecutionValueTarget as Target, type OrganizationExecutionValueMutation as Receipt } from './gen/golf/v1/golf_pb';

type Broker = Client<typeof OrganizationExecutionValueService>;
const decimal = (v: string, zero = false) => /^(?:0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n && (zero || v !== '0');
const name = (v: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v) && v !== '.' && v !== '..';
const sameTarget = (a: Target | undefined, b: Target) => Boolean(a && a.organization === b.organization && a.organizationId === b.organizationId);
function validItem(v: Item, organization: string) {
 const x = v.value;
 return Boolean(x && isRunID(x.id) && /^[A-Z][A-Z0-9_]{0,63}$/.test(x.name) && [Kind.SECRET, Kind.VARIABLE].includes(x.kind) && decimal(x.version) && Number.isFinite(Date.parse(x.createdAt)) && Number.isFinite(Date.parse(x.updatedAt)) && Number.isFinite(Date.parse(v.shareExpiresAt)) && v.shareState === 'requires_current_authority' && v.selectedRepositories.length <= 20 && new Set(v.selectedRepositories.map(r => r.repositoryId)).size === v.selectedRepositories.length && new Set(v.selectedRepositories.map(r => r.repository?.name)).size === v.selectedRepositories.length && v.selectedRepositories.every(r => decimal(r.repositoryId) && r.repository?.owner === organization && name(r.repository.name)));
}
type Edit = { id: string; initial: Item | null; value: string; policyOnly: boolean };
type Save = { name: string; kind: Kind; value?: string; selectedRepositories: { repository: { owner: string; name: string }; repositoryId: string }[]; expiresAt: string };
function Editor({ edit, organization, pending, save, cancel }: { edit: Edit; organization: string; pending: boolean; save: (v: Save) => void; cancel: () => void }) {
 const first = useRef<HTMLInputElement>(null);
 const form = useForm({ defaultValues: { name: edit.initial?.value?.name || '', kind: edit.initial?.value?.kind || Kind.SECRET, value: edit.value, expiresAt: edit.initial?.shareExpiresAt || new Date(Date.now() + 15 * 60_000).toISOString(), repositories: edit.initial?.selectedRepositories.map(r => ({ name: r.repository!.name, id: r.repositoryId })) || [] as { name: string; id: string }[] }, validators: { onSubmit: ({ value: v }) => {
  const bytes = new TextEncoder().encode(v.value).length;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(v.name) || (!edit.policyOnly && (bytes > 8192 || bytes < (v.kind === Kind.SECRET ? 8 : 1) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(v.value))) || !Number.isFinite(Date.parse(v.expiresAt)) || v.repositories.length > 20 || new Set(v.repositories.map(r => r.id)).size !== v.repositories.length || new Set(v.repositories.map(r => r.name)).size !== v.repositories.length || v.repositories.some(r => !decimal(r.id) || !name(r.name))) return 'Use a safe name, bounded value, exact repository names/IDs and valid expiry.';
 } }, onSubmit: ({ value: v }) => save({ name: v.name, kind: v.kind, value: edit.policyOnly ? undefined : v.value, expiresAt: v.expiresAt, selectedRepositories: v.repositories.map(r => ({ repository: { owner: organization, name: r.name }, repositoryId: r.id })) }) });
 useEffect(() => { first.current?.focus(); }, []);
 return <form autoComplete="off" aria-label="Organization execution value editor" onSubmit={e => { e.preventDefault(); void form.handleSubmit(); }}>
  <form.Field name="name">{f => <><label htmlFor="org-value-name">Name</label><input id="org-value-name" ref={first} disabled={pending || Boolean(edit.initial)} maxLength={64} value={f.state.value} onChange={e => f.handleChange(e.target.value)} /></>}</form.Field>
  <form.Field name="kind">{f => <><label htmlFor="org-value-kind">Type</label><select id="org-value-kind" disabled={pending || Boolean(edit.initial)} value={f.state.value} onChange={e => f.handleChange(Number(e.target.value))}><option value={Kind.SECRET}>Secret</option><option value={Kind.VARIABLE}>Variable</option></select></>}</form.Field>
  {!edit.policyOnly ? <form.Subscribe selector={s => s.values.kind}>{kind => <form.Field name="value">{f => <><label htmlFor="org-value-body">{kind === Kind.SECRET && edit.initial ? 'Replacement secret' : 'Value'}</label><input id="org-value-body" type={kind === Kind.SECRET ? 'password' : 'text'} autoComplete="new-password" disabled={pending} maxLength={8192} value={f.state.value} onChange={e => f.handleChange(e.target.value)} /></>}</form.Field>}</form.Subscribe> : <p className="field-help">Sharing-only edit retains the encrypted value. No content is read or sent.</p>}
  <form.Field name="expiresAt">{f => <><label htmlFor="org-value-expiry">Share expiry (RFC3339, before your session expires)</label><input id="org-value-expiry" disabled={pending} value={f.state.value} onChange={e => f.handleChange(e.target.value)} /></>}</form.Field>
  <form.Field name="repositories">{f => <fieldset disabled={pending}><legend>Selected repositories · exact native identities</legend><p className="field-help">Only named repositories in {organization} receive inherited metadata. Empty selection shares with none; the server verifies current ownership.</p>{f.state.value.map((r, i) => <div className="credential-form-content" key={i}><label htmlFor={`org-repo-name-${i}`}>Repository name {i + 1}</label><input id={`org-repo-name-${i}`} value={r.name} onChange={e => f.handleChange(f.state.value.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /><label htmlFor={`org-repo-id-${i}`}>Native repository ID {i + 1}</label><input id={`org-repo-id-${i}`} value={r.id} onChange={e => f.handleChange(f.state.value.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} /><button className="icon-button" type="button" aria-label={`Remove selected repository ${i + 1}`} onClick={() => f.handleChange(f.state.value.filter((_, j) => j !== i))}><Trash2 size={16} /></button></div>)}<button className="button secondary" type="button" disabled={pending || f.state.value.length >= 20} onClick={() => f.handleChange([...f.state.value, { name: '', id: '' }])}><Plus size={15} />Add repository</button></fieldset>}</form.Field>
  <p className="field-help">A change creates an immutable version and fences prior attempts. Secrets are never revealed. Sharing metadata alone does not authorize execution; each repository needs a current exact-source approval.</p>
  <form.Subscribe selector={s => s.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
  <div className="credential-actions"><button className="button primary" disabled={pending} type="submit">Save value</button><button className="button secondary" disabled={pending} type="button" onClick={cancel}>Cancel</button></div>
 </form>;
}
type Intent = { target: Target; operation: string; id: string; action: string; version: string; broker: string };
function pendingIntent(key: string, target: Target): Intent | null {
 const raw = sessionStorage.getItem(key); if (!raw) return null;
 if (raw.length > 4096) throw new Error(); const v = JSON.parse(raw) as Intent;
 if (!v || Object.keys(v).sort().join(',') !== 'action,broker,id,operation,target,version' || Object.keys(v.target || {}).sort().join(',') !== 'organization,organizationId' || !sameTarget(v.target, target) || !isRunID(v.operation) || !isRunID(v.id) || !['save_value', 'delete_value'].includes(v.action) || !decimal(v.version, true) || !decimal(v.broker, true)) throw new Error();
 return v;
}
function Removal({ item, pending, cancel, confirm }: { item: Item; pending: boolean; cancel: () => void; confirm: () => void }) {
 const dialog = useRef<HTMLDialogElement>(null), button = useRef<HTMLButtonElement>(null);
 useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); button.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
 return <dialog ref={dialog} className="create-dialog" aria-labelledby="org-value-remove" onClose={cancel} onCancel={e => { if (pending) e.preventDefault(); }}><h2 id="org-value-remove">Remove {item.value!.name}?</h2><p>Fence affected attempts. Historical encrypted versions remain retained; this does not erase execution history.</p><div className="dialog-actions"><button ref={button} className="button secondary" disabled={pending} onClick={cancel}>Cancel</button><button className="button primary" disabled={pending} onClick={confirm}>Confirm removal</button></div></dialog>;
}
function OrganizationExecutionValuesScope({ client, userId, signingOut, organization, organizationId, canManage }: { client: Broker; userId: string; signingOut: boolean; organization: string; organizationId: string; canManage: boolean }) {
 const target = { organization, organizationId } as Target, scope = JSON.stringify(target), base = ['organization-execution-values', userId, organization, organizationId];
 const key = `golf.organization-execution-operation.v1:${encodeURIComponent(userId)}:${organizationId}`;
 const initial = useRef<{ intent: Intent | null; invalid: boolean } | null>(null);
 if (!initial.current) { try { initial.current = { intent: pendingIntent(key, target), invalid: false }; } catch { initial.current = { intent: null, invalid: true }; } }
 const cache = useQueryClient(), current = useRef({ scope, userId, canManage, signingOut }); current.current = { scope, userId, canManage, signingOut };
 const generation = useRef(0), mounted = useRef(true), busy = useRef(false), abort = useRef<AbortController | null>(null);
 const [edit, setEdit] = useState<Edit | null>(null), [remove, setRemove] = useState<Item | null>(null), [pending, setPending] = useState(false), [operation, setOperation] = useState(initial.current.intent), [notice, setNotice] = useState(''), [failure, setFailure] = useState('');
 const inventory = useQuery({ ...privateQuery, queryKey: [...base, 'inventory'], enabled: canManage && !signingOut && decimal(organizationId) && name(organization), queryFn: async ({ signal }) => { const r = await client.listOrganizationExecutionValues({ target }, { signal, timeoutMs: 15_000 }); if (!sameTarget(r.target, target) || !decimal(r.brokerRevision, true) || r.maximumValues !== 64 || r.maximumSelectedRepositories !== 20 || r.consumerProfile !== 'golf.repository-env.v1' || r.values.length > 64 || r.values.some(v => !validItem(v, organization)) || new Set(r.values.map(v => v.value!.id)).size !== r.values.length || new Set(r.values.map(v => v.value!.name)).size !== r.values.length) throw new ConnectError('Organization value inventory is incomplete.', Code.Internal); return r; } });
 const readable = canManage && !signingOut && inventory.isSuccess && !inventory.isFetching && !inventory.error;
 const disabled = !readable || pending || Boolean(operation) || initial.current.invalid;
 function clear(preserveNotice = false) { generation.current++; abort.current?.abort(); setEdit(null); setRemove(null); if (!preserveNotice) setNotice(''); }
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; abort.current?.abort(); void cache.cancelQueries({ queryKey: base }); cache.removeQueries({ queryKey: base }); }; }, []);
 useEffect(() => { clear(); }, [scope, userId, canManage, signingOut]);
 useEffect(() => { if (!readable) clear(true); }, [readable]);
 const alive = (g: number, frozen: string, actor: string) => mounted.current && generation.current === g && current.current.scope === frozen && current.current.userId === actor && current.current.canManage && !current.current.signingOut;
 function receipt(r: Receipt | undefined, intent: Intent) { if (!r || !sameTarget(r.target, intent.target) || r.operationId !== intent.operation || r.itemId !== intent.id || r.action !== intent.action || r.acceptedVersion !== (BigInt(intent.version) + 1n).toString() || r.acceptedBrokerRevision !== (BigInt(intent.broker) + 1n).toString() || !Number.isFinite(Date.parse(r.committedAt))) throw new ConnectError('Organization change could not be confirmed.', Code.Internal); }
 async function dispatch(action: string, id: string, version: string, write: (intent: Intent, signal: AbortSignal) => Promise<{ operation?: Receipt }>) {
  if (disabled || busy.current || !inventory.data) return; busy.current = true; setPending(true); setFailure(''); setNotice('');
  const intent = { target: { ...target }, operation: crypto.randomUUID(), id, action, version, broker: inventory.data.brokerRevision }, g = generation.current, frozen = scope, actor = userId, controller = new AbortController(); abort.current = controller;
  try { sessionStorage.setItem(key, JSON.stringify(intent)); } catch { busy.current = false; setPending(false); setFailure('Operation metadata could not be stored. No change was sent.'); return; } setOperation(intent);
  try { const r = await write(intent, controller.signal); receipt(r.operation, intent); if (alive(g, frozen, actor)) { sessionStorage.removeItem(key); setOperation(null); setEdit(null); setRemove(null); setNotice('Organization value change confirmed.'); await inventory.refetch(); } }
  catch (e) { if (alive(g, frozen, actor)) { if (e instanceof ConnectError && e.metadata.get('Golf-Execution-Effect') === 'none') { sessionStorage.removeItem(key); setOperation(null); setFailure('The change was refused before commit. Refresh and review before an explicit new attempt.'); } else { setEdit(null); setRemove(null); setFailure('The change could not be confirmed. Inspect the original operation before another change. No automatic retry was made.'); } } }
  finally { busy.current = false; if (mounted.current) setPending(false); if (abort.current === controller) abort.current = null; }
 }
 async function inspect() {
  if (!operation || pending || !readable || !sameTarget(operation.target, target)) return; setPending(true); const intent = operation, g = generation.current, frozen = scope, actor = userId, controller = new AbortController(); abort.current = controller;
  try { const r = await client.getOrganizationExecutionValueOperation({ target, operationId: intent.operation }, { signal: controller.signal, timeoutMs: 15_000 }); receipt(r.operation, intent); if (alive(g, frozen, actor)) { sessionStorage.removeItem(key); setOperation(null); setFailure(''); setNotice('Recorded organization change confirmed.'); await inventory.refetch(); } } catch { if (alive(g, frozen, actor)) setFailure('Original operation status remains unconfirmed. No replacement was sent.'); } finally { if (mounted.current) setPending(false); }
 }
 async function open(item: Item, policyOnly = false) {
  if (disabled) return; clear(); setFailure(''); const value = item.value!;
  if (policyOnly || value.kind === Kind.SECRET || value.deleted) { setEdit({ id: value.id, initial: item, value: '', policyOnly }); return; }
  const g = generation.current, frozen = scope, actor = userId, controller = new AbortController(); abort.current = controller; setPending(true);
  try { const r = await client.getOrganizationExecutionVariable({ target, id: value.id, version: value.version }, { signal: controller.signal, timeoutMs: 15_000 }); if (!sameTarget(r.target, target) || !r.variable || !validItem(r.variable, organization) || r.variable.value?.id !== value.id || r.variable.value.version !== value.version || r.variable.value.name !== value.name || r.variable.value.kind !== Kind.VARIABLE || r.variable.value.deleted || new TextEncoder().encode(r.value).length > 8192 || !r.value || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(r.value)) throw new ConnectError('Variable version changed.', Code.Internal); if (alive(g, frozen, actor)) setEdit({ id: value.id, initial: item, value: r.value, policyOnly: false }); } catch { if (alive(g, frozen, actor)) setFailure('The current organization variable could not be read. Refresh before editing.'); } finally { if (mounted.current) setPending(false); }
 }
 const columns: DataTableColumn<Item>[] = [
  { id: 'name', header: 'Name', accessorFn: r => r.value!.name, cell: ({ row }) => <code>{row.original.value!.name}</code> },
  { id: 'type', header: 'Type', accessorFn: r => r.value!.kind === Kind.SECRET ? 'Secret' : 'Variable' },
  { id: 'version', header: 'Version', accessorFn: r => r.value!.version },
  { id: 'repositories', header: 'Selected repositories', accessorFn: r => r.selectedRepositories.map(x => x.repository!.name).join(', ') || 'None' },
  { id: 'state', header: 'Share', accessorFn: r => r.value!.deleted ? 'Removed' : Date.parse(r.shareExpiresAt) <= Date.now() ? 'Expired' : 'Requires current authority' },
  { id: 'expiry', header: 'Expires', accessorFn: r => r.shareExpiresAt, cell: ({ row }) => <DateLabel value={row.original.shareExpiresAt} /> },
  { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <div className="row-actions"><button className="icon-button" disabled={disabled} aria-label={`${row.original.value!.kind === Kind.SECRET ? 'Replace secret' : 'Edit variable'} ${row.original.value!.name}`} title="Replace value" onClick={() => void open(row.original)}><Pencil size={16} /></button><button className="icon-button" disabled={disabled || row.original.value!.deleted} aria-label={`Edit sharing ${row.original.value!.name}`} title="Edit sharing without reading content" onClick={() => void open(row.original, true)}><ShieldCheck size={16} /></button><button className="icon-button" disabled={disabled || row.original.value!.deleted} aria-label={`Remove value ${row.original.value!.name}`} title="Remove value" onClick={() => { clear(); setRemove(row.original); }}><Trash2 size={16} /></button></div> },
 ];
 if (signingOut) return null;
 if (!canManage) return <p className="field-help">Current native organization ownership is required to manage organization values.</p>;
 if (inventory.error) return <PanelError error={inventory.error} retry={() => { clear(); void inventory.refetch(); }} />;
 return <section className="browser-panel credential-list-panel" aria-labelledby="organization-values-title"><div className="browser-panel-heading"><h2 id="organization-values-title"><KeyRound size={18} />Organization secrets and variables</h2><div className="credential-actions"><button className="icon-button" disabled={pending} aria-label="Refresh organization values" title="Refresh inventory" onClick={() => { clear(); void inventory.refetch(); }}><RefreshCw size={16} /></button><button className="button secondary" disabled={disabled} onClick={() => { clear(); setEdit({ id: crypto.randomUUID(), initial: null, value: '', policyOnly: false }); }}><Plus size={15} />Add value</button></div></div>
  <p className="field-help">Partial · selected-repository sharing for the maintained Actions consumer. This inventory is an observation, not continuing share or execution authority. OIDC and environment scopes remain separate.</p>
  {initial.current.invalid ? <p className="error" role="alert">Saved operation metadata is invalid. Inspect it before another change.</p> : null}{failure ? <p className="error" role="alert">{failure}</p> : null}{notice ? <p className="session-notice" role="status">{notice}</p> : null}
  {operation && readable ? <button className="button secondary" disabled={pending} onClick={() => void inspect()}><Check size={15} />Check operation status</button> : null}
  {!readable ? <Loading label="Loading organization execution values…" /> : <>{edit ? <div className="credential-form-content"><h3>{edit.policyOnly ? 'Edit selected sharing' : edit.initial ? 'Replace value' : 'Add value'}</h3><Editor key={`${edit.id}:${edit.policyOnly}`} edit={edit} organization={organization} pending={pending} cancel={() => setEdit(null)} save={v => void dispatch('save_value', edit.id, edit.initial?.value!.version || '0', (intent, signal) => client.saveOrganizationExecutionValue({ target, id: intent.id, expectedVersion: intent.version, expectedBrokerRevision: intent.broker, operationId: intent.operation, ...v }, { signal, timeoutMs: 15_000 }))} /></div> : null}<DataTable label="Organization secrets and variables" data={inventory.data.values} columns={columns} getRowId={r => r.value!.id} emptyMessage="No organization execution values configured." /></>}
  {remove && readable ? <Removal item={remove} pending={pending} cancel={() => { if (!pending) setRemove(null); }} confirm={() => void dispatch('delete_value', remove.value!.id, remove.value!.version, (intent, signal) => client.deleteOrganizationExecutionValue({ target, id: intent.id, expectedVersion: intent.version, expectedBrokerRevision: intent.broker, operationId: intent.operation }, { signal, timeoutMs: 15_000 }))} /> : null}
 </section>;
}

export function OrganizationExecutionValues(props: { client: Broker; userId: string; signingOut: boolean; organization: string; organizationId: string; canManage: boolean }) {
 if (props.signingOut) return null;
 if (!props.canManage) return <p className="field-help">Current native organization ownership is required to manage organization values.</p>;
 if (!decimal(props.organizationId) || !name(props.organization)) return <p className="error" role="alert">Organization identity could not be verified.</p>;
 return <OrganizationExecutionValuesScope key={`${props.userId}:${props.organizationId}:${props.organization}`} {...props} />;
}
