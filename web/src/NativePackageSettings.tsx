import { NativePackageRetention } from './NativePackageRetention';
import { useState } from 'react';
import { NativePackageTrust } from './NativePackageTrust';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeAPI } from './NativeForge';
import { Loading, PanelError, privateQuery } from './RepositoryUI';

type Props = { userId: string; repository: { owner: string; name: string }; repositoryId: string; canManage: boolean };
type Settings = { scanOnPush: boolean; immutableTags: boolean; readOnly: boolean; policyMode: string; maxSeverity: string; requireVerifiedSignature: boolean; requiredProvenanceBuilder: string; maxScanAgeHours: number; retentionDays: number };
type Result = { repositoryId: string; settings: Settings; revision: number; scannerConfigured: boolean; scannerExecutor?: 'managed' | 'external' | null };
export function NativePackageSettings(p: Props) {
  const [editing, setEditing] = useState(false);
  const cache = useQueryClient(), queryKey = ['native-package-settings', p.userId, p.repositoryId];
  const result = useQuery({ ...privateQuery, queryKey, retry: false, queryFn: async ({ signal }) => {
    const value = await nativeAPI<Result>('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'settings' }, signal);
    if (value.repositoryId !== p.repositoryId) throw Error('Registry settings identity mismatch.');
    return value;
  } });
  const mutation = useMutation({ mutationFn: (settings: Settings) => nativeAPI('/native/repository-packages', { repository: p.repository, repositoryId: p.repositoryId, action: 'updateSettings', settings, expectedRevision: result.data!.revision }), onSuccess: async () => { setEditing(false); await cache.invalidateQueries({ queryKey }); } });
  if (result.isError) return <PanelError error={result.error} retry={() => void result.refetch()} />;
  if (!result.data || result.isFetching) return <Loading label="Loading registry policy…" />;
  return <><h3>Registry policy</h3><p className="field-help">Scans use the configured registry scanner. Supplied evidence does not satisfy scan or signature policies. Retention changes require reviewing and applying a deletion preview.</p>
    {editing && p.canManage ? <><PolicyForm key={result.data.revision} settings={result.data.settings} scanner={result.data.scannerConfigured} disabled={mutation.isPending} save={settings => mutation.mutate(settings)} /><button className="button secondary" disabled={mutation.isPending} onClick={() => setEditing(false)}>Cancel editing</button></> : <>
      <dl><dt>Scanner</dt><dd>{result.data.scannerConfigured ? result.data.settings.scanOnPush ? 'Scan on publication' : 'Manual scans' : 'Not configured'}</dd>
        <dt>Execution</dt><dd>{result.data.scannerExecutor === 'external' ? 'Operator-hosted runner' : result.data.scannerExecutor === 'managed' ? 'Cloudflare Containers' : 'Not reported'}</dd><dt>Policy enforcement</dt><dd>{result.data.settings.policyMode}</dd><dt>Severity threshold</dt><dd>{result.data.settings.maxSeverity}</dd>
        <dt>Maximum scan age</dt><dd>{result.data.settings.maxScanAgeHours} hours</dd><dt>Trusted signature required</dt><dd>{result.data.settings.requireVerifiedSignature ? 'Yes' : 'No'}</dd>
        <dt>Required SLSA v1 builder</dt><dd>{result.data.settings.requiredProvenanceBuilder || 'Not required'}</dd><dt>Immutable tags</dt><dd>{result.data.settings.immutableTags ? 'Yes' : 'No'}</dd><dt>Read only</dt><dd>{result.data.settings.readOnly ? 'Yes' : 'No'}</dd>
        <dt>Untagged artifact retention</dt><dd>{result.data.settings.retentionDays ? `${result.data.settings.retentionDays} days; apply a preview below` : 'Disabled'}</dd></dl>
      {p.canManage ? <button className="button secondary" onClick={() => { mutation.reset(); setEditing(true); }}>Edit registry policy</button> : null}
    </>}
    <NativePackageTrust {...p} /><NativePackageRetention {...p} />
    {mutation.isError ? <PanelError error={mutation.error} retry={() => void result.refetch()} /> : mutation.isSuccess ? <p role="status">Registry policy saved.</p> : null}
  </>;
}
function PolicyForm({ settings, scanner, disabled, save }: { settings: Settings; scanner: boolean; disabled: boolean; save: (s: Settings) => void }) {
  const form = useForm({ defaultValues: settings, onSubmit: ({ value }) => save(value) });
  return <form className="credential-form-content" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}><fieldset disabled={disabled}>
    {(['scanOnPush', 'immutableTags', 'readOnly', 'requireVerifiedSignature'] as const).map(name => <form.Field key={name} name={name}>{field => <label><input type="checkbox" checked={field.state.value} disabled={name === 'scanOnPush' && !scanner} onChange={e => field.handleChange(e.target.checked)} />{{ scanOnPush: 'Scan on publication', immutableTags: 'Make existing tags immutable', readOnly: 'Read only repository', requireVerifiedSignature: 'Require a trusted signature for policy approval' }[name]}</label>}</form.Field>)}
    {!scanner ? <p className="field-help">The native scanner has not been configured for this installation.</p> : null}
    <form.Field name="policyMode">{field => <label>Policy enforcement<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}><option value="advisory">Advisory</option><option value="promotion">Require approval for promotion</option><option value="pull">Require approval for pulls</option></select></label>}</form.Field>
    <form.Field name="maxSeverity">{field => <label>Block vulnerabilities at or above<select value={field.state.value} onChange={e => field.handleChange(e.target.value)}>{['critical', 'high', 'medium', 'low', 'none'].map(v => <option key={v} value={v}>{v}</option>)}</select></label>}</form.Field>
    <form.Field name="requiredProvenanceBuilder">{field => <label>Required SLSA v1 builder identity (empty disables)<input value={field.state.value} maxLength={256} onChange={e => field.handleChange(e.target.value)} /><span className="field-help">Requires a trusted-key signature on a statement naming this exact builder and artifact digest. It does not assert a SLSA level.</span></label>}</form.Field>
    <form.Field name="maxScanAgeHours">{field => <label>Maximum scan age (hours)<input type="number" min={1} max={8760} value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>}</form.Field>
    <form.Field name="retentionDays">{field => <label>Untagged artifact retention (days, 0 disables)<input type="number" min={0} max={3650} value={field.state.value} onChange={e => field.handleChange(Number(e.target.value))} /></label>}</form.Field>
    <button className="button" type="submit">Save registry policy</button></fieldset></form>;
}
