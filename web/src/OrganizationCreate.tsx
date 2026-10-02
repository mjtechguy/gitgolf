import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { organizationCreationApi, errorMessage } from './api';
import { OrganizationVisibility, type Organization, type User } from './gen/golf/v1/golf_pb';
import { privateQuery } from './RepositoryUI';

type Draft = { username: string; fullName: string; description: string };
function CreateEditor({ pending, submit, cancel }: { pending: boolean; submit: (draft: Draft) => void; cancel: () => void }) {
  const id = useId(); const first = useRef<HTMLInputElement>(null);
  const form = useForm({ defaultValues: { username: '', fullName: '', description: '' }, onSubmit: ({ value }) => submit(value) });
  useEffect(() => { first.current?.focus(); }, []);
  return <form className="credential-form-content" aria-label="Create private organization" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
    <form.Field name="username">{field => <><label htmlFor={`${id}-username`}>Organization name</label><input id={`${id}-username`} ref={first} autoComplete="off" value={field.state.value} required maxLength={40} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Field name="fullName">{field => <><label htmlFor={`${id}-fullname`}>Organization display name</label><input id={`${id}-fullname`} value={field.state.value} maxLength={100} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <form.Field name="description">{field => <><label htmlFor={`${id}-description`}>Organization description</label><textarea id={`${id}-description`} rows={3} value={field.state.value} maxLength={255} disabled={pending} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} /></>}</form.Field>
    <p className="field-help">This creates a private organization owned by your current native account. Golf policy permits the request; native account permission is checked during creation and can still deny it. This initial editor does not change repository access, create teams, or enable execution.</p>
    <div className="credential-actions"><button className="button primary" type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create private organization'}</button><button className="button secondary" type="button" disabled={pending} onClick={cancel}>Cancel</button></div>
  </form>;
}
export function OrganizationCreate({ userId, signingOut, onCreated }: { userId: string; signingOut: boolean; onCreated: (organization: Organization) => void | Promise<void> }) {
  const client = useQueryClient();
  const query = useQuery({ ...privateQuery, queryKey: ['organization-creation-policy', userId], enabled: !signingOut, queryFn: async ({ signal }) => { const result = await organizationCreationApi.getOrganizationCreationPolicy({}, { signal, timeoutMs: 8_000 }); if (!result.policy || result.policy.enforcementScope !== 'Golf API' || !/^(0|[1-9][0-9]*)$/.test(result.policy.revision)) throw new Error('Organization creation eligibility could not be verified.'); return result.policy; } });
  const [editing, setEditing] = useState(false); const [pending, setPending] = useState(false); const [unknown, setUnknown] = useState(false); const [notice, setNotice] = useState(''); const [validation, setValidation] = useState('');
  const alive = useRef(true); const controller = useRef<AbortController | null>(null); const createButton = useRef<HTMLButtonElement>(null);
  const active = () => alive.current && client.getQueryData<User | null>(['session'])?.id === userId;
  function abandon() { if (controller.current) { controller.current.abort(); setUnknown(true); setNotice('Creation could not be confirmed. Inspect your organization list before any separate attempt. No automatic retry was made.'); } setEditing(false); }
  useEffect(() => { alive.current = true; window.addEventListener('pagehide', abandon); return () => { alive.current = false; controller.current?.abort(); window.removeEventListener('pagehide', abandon); }; }, []);
  useEffect(() => { if (signingOut) abandon(); }, [signingOut]);
  useEffect(() => { if (query.error || (query.isSuccess && !query.data.canCreate)) setEditing(false); }, [query.error, query.isSuccess, query.data]);
  const policy = !query.error && query.isSuccess && !query.isFetching && !signingOut ? query.data : undefined;
  async function submit(draft: Draft) {
    if (!policy?.canCreate || !editing || controller.current || unknown || signingOut || !active()) return;
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(draft.username) || draft.username.includes('..') || bytes(draft.fullName) > 100 || bytes(draft.description) > 255 || /\p{Cc}/u.test((draft.fullName + draft.description).replace(/[\r\n\t]/g, ''))) { setValidation('Use a valid organization name and display name/description up to 100/255 UTF-8 bytes.'); return; }
    const request = new AbortController(); controller.current = request; setPending(true); setValidation(''); setNotice('');
    try {
      const response = await organizationCreationApi.createOrganization({ ...draft, visibility: 'private', expectedPolicyRevision: policy.revision }, { signal: request.signal, timeoutMs: 15_000 });
      if (!active() || request.signal.aborted) return;
      const organization = response.organization;
      if (!organization || !/^[1-9][0-9]{0,18}$/.test(organization.id) || BigInt(organization.id) > 9223372036854775807n || organization.name.toLowerCase() !== draft.username.toLowerCase() || organization.fullName !== draft.fullName || organization.description !== draft.description || organization.visibility !== OrganizationVisibility.PRIVATE) throw new Error('The created organization could not be verified.');
      setEditing(false); setNotice(`Private organization ${organization.name} created.`); await onCreated(organization); if (active()) createButton.current?.focus();
    } catch (error) { if (active() && !request.signal.aborted) { setEditing(false); setUnknown(true); setNotice(`${errorMessage(error instanceof Error ? error : new Error('The creation result could not be confirmed.'))} Inspect your organization list before any separate attempt. No automatic retry was made.`); } }
    finally { if (controller.current === request) controller.current = null; if (alive.current) setPending(false); }
  }
  if (signingOut) return null;
  return <div className="credential-form-content" aria-label="Organization creation">
    {policy?.canCreate ? <button ref={createButton} className="button primary" disabled={editing || pending || unknown} onClick={() => { setEditing(true); setNotice(''); }}>New organization</button> : null}
    {editing && policy?.canCreate && !unknown ? <CreateEditor pending={pending} submit={draft => void submit(draft)} cancel={() => { setEditing(false); setValidation(''); createButton.current?.focus(); }} /> : null}
    {validation ? <p className="error" role="alert">{validation}</p> : null}{notice ? <p className="panel-footnote" role={unknown ? 'alert' : 'status'}>{notice}</p> : null}
    {query.error ? <p className="field-help">Organization creation eligibility is unavailable. <button className="text-button" disabled={pending} onClick={() => void query.refetch()}>Refresh creation eligibility</button></p> : policy && !policy.canCreate ? <p className="field-help">Your current Golf session is not permitted to request organization creation.</p> : policy ? <p className="field-help">Golf API permission is verified. Native organization creation permission is checked during the request.</p> : null}
    {unknown ? <p className="field-help">Creation is paused in this view because the native result may have applied. Refresh the organization list and inspect the name before reopening a separate attempt; refreshing eligibility does not retry this request.</p> : null}
  </div>;
}
