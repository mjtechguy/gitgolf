import { isWorkflowPath } from './workflowPaths';
import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { executionPolicyApi, errorMessage } from './api';
import { ExecutionMode, ExecutionScope, type ExecutionPolicy, type User } from './gen/golf/v1/golf_pb';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

type Draft = { mode: ExecutionMode; selected: string; manual: boolean; push: boolean; allWorkflows: boolean; paths: string };
type Props = { userId: string; signingOut: boolean; scope: ExecutionScope; organization?: string; repository?: { owner: string; name: string } };
const modeLabel = (mode: ExecutionMode) => mode === ExecutionMode.ALL ? 'All eligible repositories' : mode === ExecutionMode.SELECTED ? 'Selected repositories' : 'Disabled';
const tokens = (value: string) => value.split(/[\s,]+/).filter(Boolean);
const sameList = (left: string[], right: string[]) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
function PolicyEditor({ policy, scope, pending, save, cancel }: { policy: ExecutionPolicy; scope: ExecutionScope; pending: boolean; save: (draft: Draft) => void; cancel: () => void }) {
  const first = useRef<HTMLSelectElement>(null);
  const id = useId();
  const form = useForm({ defaultValues: { mode: policy.mode, selected: policy.selectedRepositoryIds.join('\n'), manual: policy.manualDispatchEnabled, push: policy.pushAllowed, allWorkflows: policy.allowAllWorkflows, paths: policy.workflowPaths.join('\n') }, onSubmit: ({ value }) => save(value) });
  useEffect(() => { first.current?.focus(); }, []);
  return <form className="credential-form-content" aria-label="Edit execution policy" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="mode">{field => <><label htmlFor={`${id}-mode`}>Repository eligibility</label><select id={`${id}-mode`} ref={first} value={field.state.value} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(Number(event.target.value) as ExecutionMode)}><option value={ExecutionMode.DISABLED}>Disabled</option><option value={ExecutionMode.ALL}>{scope === ExecutionScope.REPOSITORY ? 'Enabled within inherited ceilings' : 'All eligible repositories'}</option>{scope !== ExecutionScope.REPOSITORY ? <option value={ExecutionMode.SELECTED}>Selected repositories</option> : null}</select></>}</form.Field>
    {scope !== ExecutionScope.REPOSITORY ? <form.Field name="selected">{field => <><label htmlFor={`${id}-selected`}>Selected repository IDs</label><textarea id={`${id}-selected`} rows={3} value={field.state.value} aria-describedby={`${id}-selected-help`} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /><p className="field-help" id={`${id}-selected-help`}>One immutable ID per line. Applies only to Selected repositories; IDs are validated against current native ownership.</p></>}</form.Field> : null}
    <form.Field name="manual">{field => <><label htmlFor={`${id}-manual`}>Manual dispatch</label><select id={`${id}-manual`} value={String(field.state.value)} disabled={pending} onChange={event => field.handleChange(event.target.value === 'true')}><option value="false">Denied</option><option value="true">Allowed within all ceilings</option></select></>}</form.Field>
    <form.Field name="push">{field => <><label htmlFor={`${id}-push`}>Automatic push execution</label><select id={`${id}-push`} value={String(field.state.value)} disabled={pending} aria-describedby={`${id}-push-help`} onChange={event => field.handleChange(event.target.value === 'true')}><option value="false">Denied</option><option value="true">Allowed within all ceilings</option></select><p className="field-help" id={`${id}-push-help`}>Independent of manual dispatch. Push execution also requires a current repository automation grant, supported trigger and qualified worker; this permission alone starts no runs.</p></>}</form.Field>
    <form.Field name="allWorkflows">{field => <><label htmlFor={`${id}-allWorkflows`}>Workflow selection</label><select id={`${id}-allWorkflows`} value={String(field.state.value)} disabled={pending} onChange={event => field.handleChange(event.target.value === 'true')}><option value="false">Exact paths only</option><option value="true">All supported workflows</option></select></>}</form.Field>
    <form.Field name="paths">{field => <><label htmlFor={`${id}-paths`}>Allowed workflow paths</label><textarea id={`${id}-paths`} rows={3} value={field.state.value} aria-describedby={`${id}-paths-help`} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /><p className="field-help" id={`${id}-paths-help`}>Direct .forgejo/workflows/*.yml or *.yaml, .github/workflows/*.yml or *.yaml, or .gitlab-ci.yml, one per line. Only the selected Actions directory can execute. Enter literal filenames, without wildcards. Empty exact selection denies every workflow.</p></>}</form.Field>
    <p className="field-help">Every required scope must permit the run. All includes future repositories at this ceiling, but each new repository still needs explicit repository authorization. Saving does not replay triggers or start a run.</p>
    <div className="credential-actions"><button className="button primary" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save execution policy'}</button><button className="button secondary" type="button" disabled={pending} onClick={cancel}>Cancel</button></div>
  </form>;
}

export function ExecutionPolicyPanel({ userId, signingOut, scope, organization = '', repository }: Props) {
  const client = useQueryClient();
  const queryKey = ['execution-policy', userId, scope, organization, repository?.owner ?? '', repository?.name ?? ''];
  const query = useQuery({ ...privateQuery, queryKey, enabled: !signingOut, queryFn: async ({ signal }) => { const response = await executionPolicyApi.getExecutionPolicy({ scope, organization, repository }, { signal, timeoutMs: 8_000 }); if (!response.policy || response.policy.scope !== scope || !response.policy.scopeId || !response.policy.authorityRevision) throw new Error('Execution policy could not be verified.'); return response.policy; } });
  const [editing, setEditing] = useState<ExecutionPolicy>();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState('');
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const editButton = useRef<HTMLButtonElement>(null);
  const active = () => alive.current && client.getQueryData<User | null>(['session'])?.id === userId;
  const policy = !signingOut && !query.error && query.isSuccess && !query.isFetching ? query.data : undefined;
  function abandon() { if (controller.current) { setUncertain(true); setNotice('The save outcome is unknown. Refresh and inspect the policy before another attempt. No automatic retry was made.'); controller.current.abort(); } setEditing(undefined); }
  useEffect(() => { alive.current = true; window.addEventListener('pagehide', abandon); return () => { alive.current = false; controller.current?.abort(); window.removeEventListener('pagehide', abandon); }; }, []);
  useEffect(() => { if (signingOut) abandon(); }, [signingOut]);
  useEffect(() => { if (query.error) setEditing(undefined); }, [query.error]);
  async function refresh() { if (controller.current) return; setEditing(undefined); setValidation(''); const result = await query.refetch(); if (active() && !result.error) { setUncertain(false); setNotice(''); } }
  async function save(draft: Draft) {
    if (!editing || controller.current || signingOut || uncertain || !active() || query.isFetching || query.error) return;
    const selected = draft.mode === ExecutionMode.SELECTED ? tokens(draft.selected) : [];
    const paths = draft.allWorkflows ? [] : draft.paths.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (selected.length > 100 || new Set(selected).size !== selected.length || selected.some(id => !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)) { setValidation('Provide up to 100 unique canonical repository IDs.'); return; }
    if (paths.length > 100 || new Set(paths).size !== paths.length || paths.some(path => !isWorkflowPath(path))) { setValidation('Provide up to 100 unique literal supported workflow paths.'); return; }
    const current = editing; const request = new AbortController(); controller.current = request; setPending(true); setNotice(''); setValidation('');
    try {
      const response = await executionPolicyApi.updateExecutionPolicy({ scope, organization, repository, scopeId: current.scopeId, expectedRevision: current.revision, expectedAuthorityRevision: current.authorityRevision, mode: draft.mode, selectedRepositoryIds: selected, manualDispatchEnabled: draft.manual, pushAllowed: draft.push, allowAllWorkflows: draft.allWorkflows, workflowPaths: paths }, { signal: request.signal, timeoutMs: 12_000 });
      if (!active() || request.signal.aborted) return;
      const saved = response.policy;
      if (!saved || saved.scope !== scope || saved.scopeId !== current.scopeId || saved.authorityRevision !== current.authorityRevision || !/^\d+$/.test(current.revision) || !/^\d+$/.test(current.revocationEpoch) || saved.revision !== (BigInt(current.revision) + 1n).toString() || saved.revocationEpoch !== (BigInt(current.revocationEpoch) + 1n).toString() || saved.mode !== draft.mode || saved.manualDispatchEnabled !== draft.manual || saved.pushAllowed !== draft.push || saved.allowAllWorkflows !== draft.allWorkflows || !sameList(saved.selectedRepositoryIds, selected) || !sameList(saved.workflowPaths, paths)) throw new Error('The saved policy could not be verified.');
      setEditing(undefined); setNotice('Execution policy saved.'); await query.refetch(); if (active()) editButton.current?.focus();
    } catch (error) { if (active() && !request.signal.aborted) { setEditing(undefined); setUncertain(true); setNotice(`${errorMessage(error instanceof Error ? error : new Error('The policy outcome could not be confirmed.'))} Refresh and inspect the current policy before another attempt. No automatic retry was made.`); } }
    finally { if (controller.current === request) controller.current = null; if (alive.current) setPending(false); }
  }
  return <section className="browser-panel credential-list-panel" aria-label="Execution policy">
    <div className="browser-panel-heading"><h2>Execution policy</h2><div className="credential-actions">{policy?.canEdit ? <button ref={editButton} className="button secondary" disabled={Boolean(editing) || pending || uncertain} onClick={() => { setEditing(policy); setNotice(''); }}>Edit execution policy</button> : null}<button className="button secondary" disabled={query.isFetching || pending || signingOut} onClick={() => void refresh()}><RefreshCw size={15} />Refresh execution policy</button></div></div>
    {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : !policy ? <Loading label="Verifying execution policy…" /> : <>{editing && !uncertain ? <PolicyEditor policy={editing} scope={scope} pending={pending} save={draft => void save(draft)} cancel={() => { setEditing(undefined); setValidation(''); editButton.current?.focus(); }} /> : <div className="credential-form-content"><dl className="settings-profile"><div><dt>Repository eligibility</dt><dd>{scope === ExecutionScope.REPOSITORY && policy.mode === ExecutionMode.ALL ? 'Enabled within inherited ceilings' : modeLabel(policy.mode)}</dd></div><div><dt>Selected IDs</dt><dd>{policy.selectedRepositoryIds.join(', ') || 'None'}</dd></div><div><dt>Manual dispatch</dt><dd>{policy.manualDispatchEnabled ? 'Allowed within ceilings' : 'Denied'}</dd></div><div><dt>Automatic push execution</dt><dd>{policy.pushAllowed ? 'Allowed within ceilings' : 'Denied'}</dd></div><div><dt>Workflows</dt><dd>{policy.allowAllWorkflows ? 'All supported workflows' : policy.workflowPaths.join(', ') || 'None allowed'}</dd></div><div><dt>Revision / revocation epoch</dt><dd>{policy.revision} / {policy.revocationEpoch}</dd></div></dl></div>}{validation ? <p className="error" role="alert">{validation}</p> : null}{notice && !signingOut ? <p className="panel-footnote" role={uncertain ? 'alert' : 'status'}>{notice}</p> : null}</>}
    <p className="panel-footnote">Unset scopes deny execution. Instance and repository ceilings must permit personal repositories; organization repositories also require their organization ceiling. Manual dispatch and push permission are independent and denied by default. Automatic runs require a current automation grant, supported trigger and worker in addition to every policy ceiling; saving does not start or replay work. This policy does not stop independently configured provider CI or authorize protected merges.</p>
  </section>;
}
