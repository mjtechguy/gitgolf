import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { create, equals, toBinary } from '@bufbuild/protobuf';
import { Check, LoaderCircle, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { CloudflareEnvironmentResources } from './CloudflareEnvironmentResources';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { settingAvailable } from './runtimeCapabilities';
import type { User } from './gen/golf/v1/golf_pb';
import { repositoryAccessClient } from './api';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { isCommitID, isRunID } from './navigation';
import { sourceRef, sourceRepositoryID } from './sourceReads';
import { RepositoryEnvironmentService, RepositoryEnvironmentPolicySchema, RepositoryEnvironmentTargetSchema, RepositoryEnvironmentAction as Action, RepositoryEnvironmentCapability as Capability, RepositorySourceRefKind as Kind, type RepositoryEnvironment as Environment, type RepositoryEnvironmentPolicy as Policy, type RepositoryEnvironmentTarget as Target, type RepositoryEnvironmentOperation as Operation } from './gen/golf/v1/golf_pb';

type EnvironmentClient = Client<typeof RepositoryEnvironmentService>;
type Props = { client: EnvironmentClient; userId: string; owner: string; name: string; signingOut: boolean; revalidating?: boolean; passwordConfirmationAvailable: boolean };
const number = (s: string, zero = false) => /^(?:0|[1-9][0-9]{0,18})$/.test(s) && BigInt(s) <= 9223372036854775807n && (zero || s !== '0');
const revision = (s: string) => /^[a-f0-9]{64}$/.test(s);
const component = (s: string) => /^[A-Za-z0-9_.-]{1,100}$/.test(s) && !['.', '..'].includes(s);
const text = (s: string, max: number) => s !== '' && s.trim() === s && new TextEncoder().encode(s).length <= max && !/[\p{Cc}\uD800-\uDFFF]/u.test(s);
const timestamp = (s: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(s) && Number.isFinite(Date.parse(s));
const validTarget = (t?: Target) => Boolean(t && sourceRepositoryID(t.repositoryId) && sourceRepositoryID(t.ownerId) && revision(t.accessRevision) && t.repository && component(t.repository.owner) && component(t.repository.name));
const sameTarget = (a: Target | undefined, b: Target) => Boolean(a && validTarget(a) && a.repositoryId === b.repositoryId && a.ownerId === b.ownerId && a.accessRevision === b.accessRevision && a.repository?.owner === b.repository?.owner && a.repository?.name === b.repository?.name);
function validPolicy(p?: Policy) {
  return Boolean(p && toBinary(RepositoryEnvironmentPolicySchema, p).length <= 16384 && p.sources.length <= 20 && p.allowAllSources === (p.sources.length === 0) && p.sources.every(s => [Kind.BRANCH, Kind.TAG, Kind.COMMIT].includes(s.kind) && (s.kind === Kind.COMMIT ? isCommitID(s.name) : sourceRef(s.name))) && new Set(p.sources.map(s => `${s.kind}:${s.name}`)).size === p.sources.length && p.reviewers.length <= 6 && p.reviewers.every(r => sourceRepositoryID(r.id) && component(r.login)) && new Set(p.reviewers.map(r => r.id)).size === p.reviewers.length && new Set(p.reviewers.map(r => r.login.toLowerCase())).size === p.reviewers.length && Number.isInteger(p.requiredApprovals) && p.requiredApprovals <= p.reviewers.length && (p.requiredApprovals !== 0 || !p.reviewers.length) && p.preventSelfApproval && !p.allowAdminBypass && p.protectedPreviews && Number.isInteger(p.waitSeconds) && p.waitSeconds >= 0 && p.waitSeconds <= 86400 && Number.isInteger(p.maxConcurrency) && p.maxConcurrency >= 1 && p.maxConcurrency <= 10 && Number.isInteger(p.previewTtlSeconds) && p.previewTtlSeconds >= 60 && p.previewTtlSeconds <= 604800);
}
function validEnvironment(e: Environment, t: Target) {
  return isRunID(e.id) && validTarget(e.target) && e.target!.repositoryId === t.repositoryId && e.target!.ownerId === t.ownerId && number(e.version) && text(e.name, 128) && validPolicy(e.policy) && sourceRepositoryID(e.creatorId) && sourceRepositoryID(e.updaterId) && timestamp(e.createdAt) && timestamp(e.updatedAt) && Date.parse(e.updatedAt) >= Date.parse(e.createdAt) && e.capability === Capability.CONFIGURATION_ONLY && !e.deploymentAvailable;
}
type Intent = { operationId: string; environmentId: string; action: 'save' | 'delete'; version: string; target: { repository: { owner: string; name: string }; repositoryId: string; ownerId: string; accessRevision: string } };
const storageKey = (userId: string, owner: string, name: string) => `golf.environment-operation.v1:${encodeURIComponent(userId)}:${encodeURIComponent(owner)}:${encodeURIComponent(name)}`;
function readIntent(key: string): { intent: Intent | null; corrupt: boolean } {
  try {
    const raw = sessionStorage.getItem(key); if (!raw) return { intent: null, corrupt: false }; if (raw.length > 4096) throw new Error();
    const i = JSON.parse(raw) as Intent;
    if (!i || Object.keys(i).sort().join(',') !== 'action,environmentId,operationId,target,version' || !isRunID(i.operationId) || !isRunID(i.environmentId) || !['save', 'delete'].includes(i.action) || !number(i.version, i.action === 'save') || BigInt(i.version) === 9223372036854775807n || !i.target || Object.keys(i.target).sort().join(',') !== 'accessRevision,ownerId,repository,repositoryId' || Object.keys(i.target.repository || {}).sort().join(',') !== 'name,owner' || !validTarget(create(RepositoryEnvironmentTargetSchema, i.target))) throw new Error();
    return { intent: i, corrupt: false };
  } catch { return { intent: null, corrupt: true }; }
}
function receipt(op: Operation | undefined, e: Environment | undefined, i: Intent, user: string, policy?: Policy, name?: string) {
  const original = create(RepositoryEnvironmentTargetSchema, i.target);
  if (!op || !e || !validEnvironment(e, original) || !sameTarget(op.target, original) || !sameTarget(e.target, original) || op.operationId !== i.operationId || op.environmentId !== i.environmentId || e.id !== i.environmentId || op.actorId !== user || e.updaterId !== user || op.action !== (i.action === 'save' ? Action.SAVE : Action.DELETE) || op.expectedVersion !== i.version || op.version !== String(BigInt(i.version) + 1n) || e.version !== op.version || op.state !== 'SUCCEEDED' || !timestamp(op.createdAt) || op.createdAt !== e.updatedAt || e.deleted !== (i.action === 'delete') || policy && !equals(RepositoryEnvironmentPolicySchema, e.policy!, policy) || name !== undefined && e.name !== name) throw new ConnectError('The environment receipt does not match the original accepted configuration.', Code.Internal);
  return { operation: op, environment: e };
}
function PolicyFacts({ policy: p }: { policy: Policy }) {
  return <dl className="settings-profile"><div><dt>Sources</dt><dd>{p.allowAllSources ? 'All sources' : p.sources.map(s => `${s.kind === Kind.BRANCH ? 'Branch' : s.kind === Kind.TAG ? 'Tag' : 'Commit'}: ${s.name}`).join(', ')}</dd></div><div><dt>Approvals</dt><dd>{p.requiredApprovals ? `${p.requiredApprovals} from ${p.reviewers.map(r => r.login).join(', ')}` : 'None required'} · independent approval; no admin bypass</dd></div><div><dt>Wait / concurrency</dt><dd>{p.waitSeconds}s / {p.maxConcurrency} deployment slots</dd></div><div><dt>Preview protection</dt><dd>Protected · TTL {p.previewTtlSeconds}s</dd></div></dl>;
}
type EditorInput = { name: string; policy: Policy; password: string };
function EnvironmentEditor({ initial, pending, target, active, save, cancel, onFailure }: { initial: Environment | null; pending: boolean; target: Target; active: () => boolean; save: (input: EditorInput) => void; cancel: () => void; onFailure: (error: unknown) => void }) {
  const first = useRef<HTMLInputElement>(null), alive = useRef(true), lookupBusy = useRef(false), lookupAbort = useRef<AbortController | null>(null);
  const [looking, setLooking] = useState(false), [lookupError, setLookupError] = useState('');
  const p = initial?.policy;
  const form = useForm({ defaultValues: { name: initial?.name || '', allSources: p?.allowAllSources ?? true, sources: (p?.sources || []).map(s => ({ kind: s.kind, name: s.name })), reviewers: (p?.reviewers || []).map(r => ({ id: r.id, login: r.login })), reviewerLogin: '', approvals: p?.requiredApprovals ?? 0, wait: p?.waitSeconds ?? 0, concurrency: p?.maxConcurrency ?? 1, ttl: p?.previewTtlSeconds ?? 3600, password: '' }, validators: { onSubmit: ({ value: v }) => {
    const policy = create(RepositoryEnvironmentPolicySchema, { allowAllSources: v.allSources, sources: v.sources, reviewers: v.reviewers, requiredApprovals: v.approvals, waitSeconds: v.wait, maxConcurrency: v.concurrency, previewTtlSeconds: v.ttl, preventSelfApproval: true, allowAdminBypass: false, protectedPreviews: true });
    return !text(v.name, 128) || !validPolicy(policy) || !v.password ? 'Use a bounded name, exact source restrictions, verified reviewers and your current Golf password.' : undefined;
  } }, onSubmit: ({ value: v }) => save({ name: v.name, password: v.password, policy: create(RepositoryEnvironmentPolicySchema, { allowAllSources: v.allSources, sources: v.sources, reviewers: v.reviewers, requiredApprovals: v.approvals, waitSeconds: v.wait, maxConcurrency: v.concurrency, previewTtlSeconds: v.ttl, preventSelfApproval: true, allowAdminBypass: false, protectedPreviews: true }) }) });
  useEffect(() => { alive.current = true; first.current?.focus(); return () => { alive.current = false; lookupAbort.current?.abort(); }; }, []);
  async function addReviewer() {
    const login = form.state.values.reviewerLogin;
    if (pending || lookupBusy.current || !active() || !component(login) || form.state.values.reviewers.length >= 6) return;
    lookupBusy.current = true; setLooking(true); setLookupError(''); const abort = new AbortController(); lookupAbort.current = abort;
    try {
      const r = await repositoryAccessClient.resolveRepositoryCollaborator({ repository: target.repository, repositoryId: target.repositoryId, ownerId: target.ownerId, expectedRevision: target.accessRevision, userLogin: login }, { signal: abort.signal, timeoutMs: 15_000 }); abort.signal.throwIfAborted();
      const user = r.collaborator?.user;
      if (!user || !sourceRepositoryID(user.id) || !component(user.login) || user.login.toLowerCase() !== login.toLowerCase()) throw new ConnectError('Reviewer identity could not be verified.', Code.Internal);
      if (!alive.current || !active()) return;
      const list = form.state.values.reviewers;
      if (list.some(r => r.id === user.id || r.login.toLowerCase() === user.login.toLowerCase())) { setLookupError('That reviewer is already selected.'); return; }
      form.setFieldValue('reviewers', [...list, { id: user.id, login: user.login }]); form.setFieldValue('reviewerLogin', ''); if (form.state.values.approvals === 0) form.setFieldValue('approvals', 1);
    } catch (error) { if (alive.current && active() && !abort.signal.aborted) { setLookupError(error instanceof Error ? error.message : 'Reviewer lookup failed.'); onFailure(error); } }
    finally { lookupBusy.current = false; if (alive.current && active()) setLooking(false); }
  }
  return <form aria-label="Environment configuration editor" autoComplete="off" onSubmit={e => { e.preventDefault(); if (!pending && !looking) void form.handleSubmit(); }}>
    <form.Field name="name">{f => <><label htmlFor="environment-name">Name</label><input ref={first} id="environment-name" disabled={pending} value={f.state.value} maxLength={128} onChange={e => f.handleChange(e.target.value)} /></>}</form.Field>
    <fieldset disabled={pending}><legend>Source restrictions</legend><form.Field name="allSources">{f => <label className="checkbox-field"><input type="checkbox" checked={f.state.value} onChange={e => { f.handleChange(e.target.checked); form.setFieldValue('sources', e.target.checked ? [] : [{ kind: Kind.BRANCH, name: '' }]); }} />Allow all sources</label>}</form.Field>
      <form.Subscribe selector={s => s.values.allSources}>{all => !all ? <form.Field name="sources">{f => <>{f.state.value.map((s, i) => <div className="settings-profile" key={i}><label htmlFor={`environment-source-kind-${i}`}>Source {i + 1} type</label><select id={`environment-source-kind-${i}`} value={s.kind} onChange={e => f.handleChange(f.state.value.map((r, j) => j === i ? { ...r, kind: Number(e.target.value) as Kind } : r))}><option value={Kind.BRANCH}>Branch</option><option value={Kind.TAG}>Tag</option><option value={Kind.COMMIT}>Commit</option></select><label htmlFor={`environment-source-name-${i}`}>Source {i + 1} exact name or commit</label><input id={`environment-source-name-${i}`} value={s.name} maxLength={1024} onChange={e => f.handleChange(f.state.value.map((r, j) => j === i ? { ...r, name: e.target.value } : r))} /><button type="button" className="icon-button" aria-label={`Remove source ${i + 1}`} onClick={() => f.handleChange(f.state.value.filter((_, j) => j !== i))}><X size={16} /></button></div>)}<button type="button" className="button secondary" disabled={f.state.value.length >= 20} onClick={() => f.handleChange([...f.state.value, { kind: Kind.BRANCH, name: '' }])}><Plus size={15} />Add source restriction</button></>}</form.Field> : null}</form.Subscribe><p className="field-help">Exact branch/tag literals or a verified full commit. Wildcards are unavailable. These restrictions are saved configuration, not active deployment enforcement.</p></fieldset>
    <fieldset disabled={pending || looking}><legend>Required reviewers</legend><form.Field name="reviewerLogin">{f => <><label htmlFor="environment-reviewer-login">Reviewer username</label><input id="environment-reviewer-login" value={f.state.value} onChange={e => f.handleChange(e.target.value)} maxLength={100} /><button type="button" className="button secondary" onClick={() => void addReviewer()}><Plus size={15} />Look up and add reviewer</button></>}</form.Field>{lookupError ? <p className="error" role="alert">{lookupError}</p> : null}
      <form.Field name="reviewers">{f => <ul aria-label="Selected environment reviewers">{f.state.value.map(r => <li key={r.id}>{r.login}<button type="button" className="icon-button" aria-label={`Remove reviewer ${r.login}`} onClick={() => { const remaining = f.state.value.filter(x => x.id !== r.id); f.handleChange(remaining); form.setFieldValue('approvals', Math.min(form.state.values.approvals, remaining.length)); }}><X size={15} /></button></li>)}</ul>}</form.Field>
      <form.Field name="approvals">{f => <><label htmlFor="environment-approvals">Required approvals</label><input id="environment-approvals" type="number" min={0} max={6} value={f.state.value} onChange={e => f.handleChange(Number(e.target.value))} /></>}</form.Field><p className="field-help">Up to six verified native identities. Approval separation is required; administrator bypass is unavailable. No approval is granted by adding a reviewer.</p></fieldset>
    <form.Field name="wait">{f => <><label htmlFor="environment-wait">Wait before deployment (seconds)</label><input id="environment-wait" type="number" min={0} max={86400} disabled={pending} value={f.state.value} onChange={e => f.handleChange(Number(e.target.value))} /></>}</form.Field>
    <form.Field name="concurrency">{f => <><label htmlFor="environment-concurrency">Maximum concurrent deployments</label><input id="environment-concurrency" type="number" min={1} max={10} disabled={pending} value={f.state.value} onChange={e => f.handleChange(Number(e.target.value))} /></>}</form.Field>
    <form.Field name="ttl">{f => <><label htmlFor="environment-ttl">Protected preview TTL (seconds)</label><input id="environment-ttl" type="number" min={60} max={604800} disabled={pending} value={f.state.value} onChange={e => f.handleChange(Number(e.target.value))} /></>}</form.Field>
    <form.Field name="password">{f => <><label htmlFor="environment-password">Current Golf password</label><input id="environment-password" type="password" autoComplete="current-password" disabled={pending} value={f.state.value} onChange={e => f.handleChange(e.target.value)} /></>}</form.Field>
    <form.Subscribe selector={s => s.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
    <div className="credential-actions"><button type="submit" className="button primary" disabled={pending || looking}>{pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Save environment</button><button className="button secondary" type="button" disabled={pending} onClick={cancel}>Cancel</button></div>
  </form>;
}
function EnvironmentRemoval({ row, pending, cancel, confirm }: { row: Environment; pending: boolean; cancel: () => void; confirm: (password: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), first = useRef<HTMLButtonElement>(null);
  const form = useForm({ defaultValues: { password: '' }, validators: { onSubmit: ({ value }) => !value.password ? 'Confirm with your current Golf password.' : undefined }, onSubmit: ({ value }) => confirm(value.password) });
  useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); first.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="environment-remove-title" onClose={cancel} onCancel={e => { if (pending) e.preventDefault(); }}><h2 id="environment-remove-title">Delete this environment?</h2><p><strong>{row.name}</strong> will be removed from the current inventory. Immutable configuration history remains retained; this does not delete a deployed project.</p><form aria-label="Confirm environment deletion" onSubmit={e => { e.preventDefault(); if (!pending) void form.handleSubmit(); }}><form.Field name="password">{f => <><label htmlFor="environment-remove-password">Current Golf password</label><input id="environment-remove-password" autoComplete="current-password" type="password" disabled={pending} value={f.state.value} onChange={e => f.handleChange(e.target.value)} /></>}</form.Field><form.Subscribe selector={s => s.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe><div className="dialog-actions"><button ref={first} type="button" className="button secondary" disabled={pending} onClick={cancel}>Cancel</button><button className="button session-danger" disabled={pending}>Confirm delete environment</button></div></form></dialog>;
}

export function RepositoryEnvironments(props: Props) {
  const identity = JSON.stringify([props.userId, props.owner, props.name]);
  const latest = useRef({ identity, signingOut: props.signingOut, revalidating: Boolean(props.revalidating) }); latest.current = { identity, signingOut: props.signingOut, revalidating: Boolean(props.revalidating) };
  const prior = useRef(props);
  useLayoutEffect(() => { if (prior.current.userId !== props.userId || props.signingOut) { try { sessionStorage.removeItem(storageKey(prior.current.userId, prior.current.owner, prior.current.name)); } catch { /* No private data is stored. */ } } prior.current = props; }, [identity, props.signingOut]);
  return <EnvironmentWorkspace key={identity} {...props} identity={identity} latest={latest} />;
}
function EnvironmentWorkspace({ client, userId, owner, name, signingOut, revalidating = false, passwordConfirmationAvailable, identity, latest }: Props & { identity: string; latest: React.RefObject<{ identity: string; signingOut: boolean; revalidating: boolean }> }) {
  const runtime = useRuntimeCapabilities();
  const cloudflareAvailable = settingAvailable(runtime.isError ? undefined : runtime.data, 'settings.cloudflare-resources');
  const cache = useQueryClient(), base = ['repository-environments', userId, owner, name], key = storageKey(userId, owner, name);
  const [cloudflare, setCloudflare] = useState<Environment | null>(null);
  const operator = cache.getQueryData<User | null>(['session'])?.isInstanceAdmin === true;
  const initial = useRef<ReturnType<typeof readIntent> | null>(null); if (!initial.current) initial.current = readIntent(key);
  const [intent, setIntent] = useState(initial.current.intent), [receiptState, setReceipt] = useState<{ operation: Operation; environment: Environment } | null>(null), [refused, setRefused] = useState(false), [failure, setFailure] = useState(''), [page, setPage] = useState(1), [edit, setEdit] = useState<{ id: string; initial: Environment | null } | null>(null), [remove, setRemove] = useState<Environment | null>(null), [pending, setPending] = useState(false), [denial, setDenial] = useState<Error | null>(null);
  const busy = useRef(false), alive = useRef(true), generation = useRef(0), controller = useRef<AbortController | null>(null), focus = useRef<HTMLButtonElement>(null);
  const access = useQuery({ ...privateQuery, retry: false, queryKey: [...base, 'access'], enabled: !signingOut && !revalidating && sourceRepositoryID(userId) && component(owner) && component(name), queryFn: async ({ signal }) => {
    const r = await repositoryAccessClient.getRepositoryAccess({ repository: { owner, name } }, { signal, timeoutMs: 15_000 }); signal.throwIfAborted();
    if (!r.access || !sourceRepositoryID(r.access.repositoryId) || !sourceRepositoryID(r.access.ownerId) || !revision(r.access.revision) || !r.access.owner || r.access.owner.id !== r.access.ownerId || r.access.owner.login.toLowerCase() !== owner.toLowerCase() || !['none', 'read', 'write', 'admin', 'owner'].includes(r.access.currentPermission) || r.access.canManage && !['admin', 'owner'].includes(r.access.currentPermission)) throw new ConnectError('Repository environment authority could not be verified.', Code.Internal); return r.access;
  } });
  const a = access.data;
  const target = create(RepositoryEnvironmentTargetSchema, { repository: { owner, name }, repositoryId: a?.repositoryId || '', ownerId: a?.ownerId || '', accessRevision: a?.revision || '' });
  const scope = JSON.stringify(target), valid = validTarget(target), readableAuthority = !signingOut && !revalidating && access.isSuccess && !access.isFetching && !access.error && valid && ['owner', 'admin'].includes(a!.currentPermission);
  const inventory = useQuery({ ...privateQuery, retry: false, queryKey: [...base, 'inventory', scope, page], enabled: readableAuthority && !denial, queryFn: async ({ signal }) => {
    const r = await client.listRepositoryEnvironments({ target, page: { page, limit: 20 } }, { signal, timeoutMs: 15_000 }); signal.throwIfAborted();
    if (!sameTarget(r.target, target) || r.capability !== Capability.CONFIGURATION_ONLY || r.deploymentAvailable || !r.page || !number(r.totalCount, true) || BigInt(r.totalCount) > 100n || r.environments.length > 20 || r.environments.some(e => !validEnvironment(e, target) || e.deleted) || new Set(r.environments.map(e => e.id)).size !== r.environments.length || new Set(r.environments.map(e => e.name.toLowerCase())).size !== r.environments.length || r.environments.length !== Math.max(0, Math.min(20, Number(r.totalCount) - (page - 1) * 20)) || r.page.nextPage !== (page * 20 < Number(r.totalCount) ? page + 1 : 0)) throw new ConnectError('Environment inventory does not match the selected repository and bounded page.', Code.Internal); return r;
  } });
  const readable = !denial && readableAuthority && inventory.isSuccess && !inventory.isFetching && !inventory.error;
  const writable = readable && Boolean(a?.canManage) && passwordConfirmationAvailable;
  const current = useRef({ scope, readable, writable }); current.current = { scope, readable, writable };
  const active = (stamp = generation.current, frozen = scope) => alive.current && latest.current.identity === identity && !latest.current.signingOut && !latest.current.revalidating && generation.current === stamp && current.current.scope === frozen && current.current.readable;
  const blocked = !writable || pending || Boolean(intent) || initial.current.corrupt;
  const rows = readable ? inventory.data.environments : [];
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; controller.current?.abort(); void cache.cancelQueries({ queryKey: base }); cache.removeQueries({ queryKey: base }); }; }, []);
  useLayoutEffect(() => { generation.current++; controller.current?.abort(); setEdit(null); setRemove(null); setReceipt(null); setFailure(''); setRefused(false); }, [scope]);
  useLayoutEffect(() => { if (signingOut || revalidating || access.error || inventory.error || access.isSuccess && !['owner', 'admin'].includes(access.data.currentPermission)) { generation.current++; controller.current?.abort(); setEdit(null); setRemove(null); setReceipt(null); setFailure(''); if (access.error || inventory.error) setDenial(access.error || inventory.error); void cache.cancelQueries({ queryKey: [...base, 'inventory'] }); cache.removeQueries({ queryKey: [...base, 'inventory'] }); } }, [signingOut, revalidating, access.error, inventory.error, access.isSuccess && access.data.currentPermission]);
  function remember(i: Intent) { sessionStorage.setItem(key, JSON.stringify(i)); setIntent(i); }
  function forget() { sessionStorage.removeItem(key); setIntent(null); setRefused(false); }
  function hideDenied(error: unknown) {
    if (!(error instanceof ConnectError) || ![Code.PermissionDenied, Code.NotFound, Code.Unauthenticated].includes(error.code)) return;
    generation.current++; current.current.readable = false; current.current.writable = false; controller.current?.abort(); setDenial(error); setReceipt(null); setEdit(null); setRemove(null); setFailure('');
    void cache.cancelQueries({ queryKey: [...base, 'inventory'] }); cache.removeQueries({ queryKey: [...base, 'inventory'] });
  }
  async function refresh() {
    if (busy.current || signingOut || revalidating) return;
    const stamp = generation.current; setDenial(null); setFailure(''); setReceipt(null); const r = await access.refetch();
    if (alive.current && stamp === generation.current && r.data && !r.error && r.data.repositoryId === target.repositoryId && r.data.ownerId === target.ownerId && r.data.revision === target.accessRevision) await inventory.refetch();
  }
  async function dispatch(row: Environment | null, input: EditorInput | string) {
    if (busy.current || blocked || !active()) return;
    busy.current = true; setPending(true); setFailure(''); setReceipt(null); setRefused(false);
    const deleting = typeof input === 'string';
    const i: Intent = { operationId: crypto.randomUUID(), environmentId: row?.id || edit!.id, action: deleting ? 'delete' : 'save', version: row?.version || '0', target: { repository: { owner, name }, repositoryId: target.repositoryId, ownerId: target.ownerId, accessRevision: target.accessRevision } };
    const stamp = generation.current, frozen = scope, abort = new AbortController(); controller.current = abort;
    try {
      remember(i); // A failed storage write prevents dispatch entirely.
      const r = deleting ? await client.deleteRepositoryEnvironment({ target, environmentId: i.environmentId, expectedVersion: i.version, operationId: i.operationId, currentPassword: input }, { signal: abort.signal, timeoutMs: 15_000 }) : await client.saveRepositoryEnvironment({ target, environmentId: i.environmentId, expectedVersion: i.version, operationId: i.operationId, name: input.name, policy: input.policy, currentPassword: input.password }, { signal: abort.signal, timeoutMs: 15_000 }); abort.signal.throwIfAborted();
      const result = receipt(r.operation, r.environment, i, userId, deleting ? row!.policy : input.policy, deleting ? row!.name : input.name);
      if (!active(stamp, frozen)) return;
      setReceipt(result); forget(); setEdit(null); setRemove(null); await inventory.refetch(); focus.current?.focus();
    } catch (error) {
      if (active(stamp, frozen)) { setFailure(error instanceof Error ? error.message : 'The outcome could not be confirmed.'); setRemove(null); if (error instanceof ConnectError && error.code === Code.Aborted) setRefused(true); hideDenied(error); }
    } finally { busy.current = false; if (alive.current && latest.current.identity === identity) setPending(false); if (controller.current === abort) controller.current = null; }
  }
  async function inspect() {
    if (!intent || busy.current || !active()) return;
    busy.current = true; setPending(true); setFailure(''); const stamp = generation.current, frozen = scope, abort = new AbortController(); controller.current = abort;
    try {
      if (intent.target.repositoryId !== target.repositoryId || intent.target.ownerId !== target.ownerId) throw new ConnectError('The saved operation belongs to a different native repository. No lookup or mutation was sent.', Code.FailedPrecondition);
      const r = await client.getRepositoryEnvironmentOperation({ target, operationId: intent.operationId }, { signal: abort.signal, timeoutMs: 15_000 }); abort.signal.throwIfAborted(); const result = receipt(r.operation, r.environment, intent, userId);
      if (active(stamp, frozen)) { setReceipt(result); setRefused(false); }
    } catch (error) { if (active(stamp, frozen)) { setReceipt(null); setFailure(error instanceof Error ? error.message : 'Original operation status is unavailable.'); hideDenied(error); } }
    finally { busy.current = false; if (alive.current && latest.current.identity === identity) setPending(false); if (controller.current === abort) controller.current = null; }
  }
  const columns: DataTableColumn<Environment>[] = [
    { id: 'name', header: 'Environment', accessorFn: e => e.name, cell: ({ row }) => <><strong>{row.original.name}</strong><small>Configuration only</small></> },
    { id: 'policy', header: 'Protection', accessorFn: e => `${e.policy!.requiredApprovals} approvals ${e.policy!.waitSeconds}s`, cell: ({ row }) => <>{row.original.policy!.requiredApprovals} approvals · {row.original.policy!.waitSeconds}s wait<details><summary>Policy details</summary><PolicyFacts policy={row.original.policy!} /><p className="field-help">Saved v{row.original.version} · created by native account {row.original.creatorId}; last edited by {row.original.updaterId}. These policy gates are not enforced by a deployment consumer yet.</p></details></> },
    { id: 'updated', header: 'Updated', accessorFn: e => e.updatedAt, cell: ({ row }) => <DateLabel value={row.original.updatedAt} /> },
    { id: 'actions', header: 'Actions', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => <div className="row-actions">{operator && cloudflareAvailable ? <button className="button secondary" disabled={blocked} onClick={() => setCloudflare(row.original)}>Cloudflare resources</button> : null}<button className="icon-button" title="Edit environment" aria-label={`Edit environment ${row.original.name}`} disabled={blocked} onClick={() => { setRemove(null); setFailure(''); setEdit({ id: row.original.id, initial: row.original }); }}><Pencil size={16} /></button><button className="icon-button" title="Delete environment" aria-label={`Delete environment ${row.original.name}`} disabled={blocked} onClick={() => { setEdit(null); setRemove(row.original); }}><Trash2 size={16} /></button></div> },
  ];
  if (signingOut || revalidating) return null;
  return <section className="browser-panel credential-list-panel" aria-labelledby="repository-environments-title"><div className="browser-panel-heading"><h2 id="repository-environments-title"><ShieldCheck size={18} />Environments</h2><div className="credential-actions"><button className="icon-button" aria-label="Refresh environments" title="Refresh environments" disabled={pending || access.isFetching || inventory.isFetching} onClick={() => void refresh()}><RefreshCw size={16} /></button><button ref={focus} className="button secondary" disabled={blocked || Boolean(edit)} onClick={() => { setFailure(''); setReceipt(null); setEdit({ id: crypto.randomUUID(), initial: null }); }}><Plus size={15} />Add environment</button></div></div>
    <p className="field-help">Configuration only · Deployment unavailable. Named protection policies are saved locally; live deployments, preview links and policy enforcement are not connected.</p>
    {initial.current.corrupt ? <p className="error" role="alert">Saved environment operation metadata is unreadable. New changes are blocked; inspect this browser session before continuing.</p> : null}
    {edit && !intent && valid ? <div className="credential-form-content" hidden={!readable || !writable} inert={!readable || !writable}><h3>{edit.initial ? 'Edit environment' : 'Add environment'}</h3><EnvironmentEditor key={edit.id} initial={edit.initial} pending={pending || !readable || !writable} target={target} active={() => active() && current.current.writable} onFailure={hideDenied} cancel={() => { setEdit(null); focus.current?.focus(); }} save={input => void dispatch(edit.initial, input)} /></div> : null}
    {denial || access.error || inventory.error ? <PanelError error={denial || access.error || inventory.error!} retry={() => void refresh()} /> : access.isSuccess && !['owner', 'admin'].includes(access.data.currentPermission) ? <p className="field-help">Current ordinary repository administrator authority is required to read environment configuration.</p> : !readable ? <Loading label="Checking environment configuration…" /> : <>
      {!writable ? <p className="field-help">View only. Changes require a writable repository, ordinary admin authority and a local Golf password session.</p> : null}
      {failure ? <p className="error" role="alert">{failure}</p> : null}
      {receiptState ? <div className="session-notice" role="status"><strong>{receiptState.environment.deleted ? 'Environment deleted.' : 'Environment configuration saved.'}</strong> Historical local receipt · v{receiptState.operation.version}. No deployment was performed.</div> : null}
      {intent ? <div className="credential-form-content"><h3>{refused ? 'Configuration version changed' : receiptState ? 'Original operation confirmed' : 'Environment change needs inspection'}</h3><p className="field-help">{refused ? 'The server refused this stale CAS request before committing. Discard it explicitly, then reload current values before another reviewed change.' : 'Keep the original operation identity. No automatic retry or replacement request was made; reloading only permits status inspection.'}</p><div className="credential-actions"><button className="button secondary" disabled={pending} onClick={() => void inspect()}><Check size={15} />Inspect original environment operation</button>{receiptState || refused ? <button className="button secondary" disabled={pending} onClick={() => { forget(); setEdit(null); void refresh(); }}>{refused ? 'Discard refused change' : 'Finish operation inspection'}</button> : null}</div></div> : null}
      <p className="field-help">Search and sorting cover this loaded server page.</p><DataTable label="Repository environments" data={rows} columns={columns} getRowId={e => e.id} emptyMessage="No environments configured." pagination={false} />
      <nav className="list-footer" aria-label="Environment server pages"><span>{rows.length} on this page · {inventory.data.totalCount} total environments</span><div className="credential-actions"><button className="button secondary" disabled={page === 1 || pending || Boolean(edit) || Boolean(intent)} onClick={() => setPage(p => p - 1)}>Previous environment page</button><button className="button secondary" disabled={!inventory.data.page?.nextPage || pending || Boolean(edit) || Boolean(intent)} onClick={() => setPage(inventory.data.page!.nextPage)}>Next environment page</button></div></nav>
      {cloudflare && cloudflareAvailable && operator && readable && writable ? <CloudflareEnvironmentResources key={`${cloudflare.id}:${cloudflare.version}`} userId={userId} environment={cloudflare} active={() => active() && current.current.writable} close={() => setCloudflare(null)} /> : null}
      {remove && !intent ? <EnvironmentRemoval row={remove} pending={pending} cancel={() => { if (!busy.current) setRemove(null); }} confirm={password => void dispatch(remove, password)} /> : null}
    </>}
  </section>;
}
