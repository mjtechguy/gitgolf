import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { organizationCreationApi, errorMessage } from './api';
import { OrganizationCreationMode, type OrganizationCreationPolicy, type User } from './gen/golf/v1/golf_pb';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

const label = (mode: OrganizationCreationMode) => mode === OrganizationCreationMode.ALL_USERS ? 'All users' : mode === OrganizationCreationMode.SELECTED_USERS ? 'Selected users' : 'Instance administrators only';
type Draft = { mode: OrganizationCreationMode; selected: string };
function CreationPolicyEditor({ policy, pending, save, cancel }: { policy: OrganizationCreationPolicy; pending: boolean; save: (draft: Draft) => void; cancel: () => void }) {
  const first = useRef<HTMLSelectElement>(null);
  const id = useId();
  const form = useForm({ defaultValues: { mode: policy.mode, selected: policy.selectedGolfUserIds.join('\n') }, onSubmit: ({ value }) => save(value) });
  useEffect(() => { first.current?.focus(); }, []);
  return <form className="credential-form-content" aria-label="Edit organization creation policy" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="mode">{field => <><label htmlFor={`${id}-mode`}>Who may request organizations</label><select id={`${id}-mode`} ref={first} value={field.state.value} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(Number(event.target.value) as OrganizationCreationMode)}><option value={OrganizationCreationMode.ADMINISTRATORS_ONLY}>Instance administrators only</option><option value={OrganizationCreationMode.SELECTED_USERS}>Selected users</option><option value={OrganizationCreationMode.ALL_USERS}>All users</option></select></>}</form.Field>
    <form.Field name="selected">{field => <><label htmlFor={`${id}-selected`}>Selected Golf user IDs</label><textarea id={`${id}-selected`} rows={3} value={field.state.value} aria-describedby={`${id}-selected-help`} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /><p className="field-help" id={`${id}-selected-help`}>One immutable Golf user ID per line. These are installation user IDs, distinct from native user or local account IDs. Selection applies only to Selected users.</p></>}</form.Field>
    <p className="field-help">This grants permission to request creation through Golf. Native permission is checked during creation and may deny the request. Independently exposed native APIs remain outside this ceiling; existing native grants are not changed by this save.</p>
    <div className="credential-actions"><button className="button primary" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save organization creation policy'}</button><button className="button secondary" type="button" disabled={pending} onClick={cancel}>Cancel</button></div>
  </form>;
}
export function OrganizationCreationPolicyPanel({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const client = useQueryClient();
  const query = useQuery({ ...privateQuery, queryKey: ['organization-creation-policy', userId], enabled: !signingOut, queryFn: async ({ signal }) => { const response = await organizationCreationApi.getOrganizationCreationPolicy({}, { signal, timeoutMs: 8_000 }); if (!response.policy || response.policy.enforcementScope !== 'Golf API') throw new Error('Organization creation policy could not be verified.'); return response.policy; } });
  const [editing, setEditing] = useState<OrganizationCreationPolicy>();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState('');
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const active = () => alive.current && client.getQueryData<User | null>(['session'])?.id === userId;
  const policy = !signingOut && !query.error && query.isSuccess && !query.isFetching ? query.data : undefined;
  const abandon = () => { if (controller.current) { controller.current.abort(); setUncertain(true); setNotice('The save outcome is unknown. Refresh and inspect the policy before another attempt. No automatic retry was made.'); } setEditing(undefined); };
  useEffect(() => { alive.current = true; window.addEventListener('pagehide', abandon); return () => { alive.current = false; controller.current?.abort(); window.removeEventListener('pagehide', abandon); }; }, []);
  useEffect(() => { if (signingOut) abandon(); }, [signingOut]);
  useEffect(() => { if (query.error) setEditing(undefined); }, [query.error]);
  async function refresh() { if (controller.current) return; setEditing(undefined); setValidation(''); const result = await query.refetch(); if (active() && !result.error) { setUncertain(false); setNotice(''); } }
  async function save(draft: Draft) {
    if (!editing || controller.current || signingOut || uncertain || !active() || query.isFetching || query.error) return;
    const ids = draft.mode === OrganizationCreationMode.SELECTED_USERS ? draft.selected.split(/[\s,]+/).filter(Boolean) : [];
    if (ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)) { setValidation('Provide up to 100 unique canonical Golf user IDs.'); return; }
    const before = editing; const request = new AbortController(); controller.current = request; setPending(true); setNotice(''); setValidation('');
    try {
      const response = await organizationCreationApi.updateOrganizationCreationPolicy({ expectedRevision: before.revision, mode: draft.mode, selectedGolfUserIds: ids }, { signal: request.signal, timeoutMs: 12_000 });
      if (!active() || request.signal.aborted) return;
      const saved = response.policy;
      const requested = [...ids].sort(); const actual = [...(saved?.selectedGolfUserIds ?? [])].sort();
      if (!saved || saved.enforcementScope !== 'Golf API' || saved.mode !== draft.mode || !/^\d+$/.test(before.revision) || !/^\d+$/.test(before.revocationEpoch) || saved.revision !== (BigInt(before.revision) + 1n).toString() || saved.revocationEpoch !== (BigInt(before.revocationEpoch) + 1n).toString() || actual.length !== requested.length || actual.some((id, index) => id !== requested[index])) throw new Error('The saved organization creation policy could not be verified.');
      setEditing(undefined); setNotice('Organization creation policy saved.'); await query.refetch();
    } catch (error) { if (active() && !request.signal.aborted) { setEditing(undefined); setUncertain(true); setNotice(`${errorMessage(error instanceof Error ? error : new Error('The save outcome could not be confirmed.'))} Refresh and inspect the current policy before another attempt. No automatic retry was made.`); } }
    finally { if (controller.current === request) controller.current = null; if (alive.current) setPending(false); }
  }
  return <section className="browser-panel credential-list-panel" aria-label="Organization creation policy"><div className="browser-panel-heading"><h2>Organization creation</h2><div className="credential-actions">{policy?.canEdit ? <button className="button secondary" disabled={Boolean(editing) || pending || uncertain} onClick={() => { setEditing(policy); setNotice(''); }}>Edit organization creation policy</button> : null}<button className="button secondary" disabled={query.isFetching || pending || signingOut} onClick={() => void refresh()}>Refresh organization creation policy</button></div></div>
    {query.error ? <PanelError error={query.error} retry={() => void refresh()} /> : !policy ? <Loading label="Verifying organization creation policy…" /> : <>{editing && !uncertain ? <CreationPolicyEditor policy={editing} pending={pending} save={draft => void save(draft)} cancel={() => { setEditing(undefined); setValidation(''); }} /> : <div className="credential-form-content"><dl className="settings-profile"><div><dt>Who may request creation</dt><dd>{label(policy.mode)}</dd></div><div><dt>Selected Golf user IDs</dt><dd>{policy.selectedGolfUserIds.join(', ') || 'None disclosed'}</dd></div><div><dt>Enforcement</dt><dd>{policy.enforcementScope}</dd></div><div><dt>Revision / revocation epoch</dt><dd>{policy.revision} / {policy.revocationEpoch}</dd></div></dl></div>}{validation ? <p className="error" role="alert">{validation}</p> : null}{notice && !signingOut ? <p className="panel-footnote" role={uncertain ? 'alert' : 'status'}>{notice}</p> : null}</>}
    <p className="panel-footnote">Native organization creation permission is checked during the actual request. Golf cannot preflight the native per-user grant through its current API. This setting does not change existing native permissions or stop independently authenticated native API requests.</p>
  </section>;
}
