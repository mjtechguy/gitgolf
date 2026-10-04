import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { Pencil, RefreshCw, X } from 'lucide-react';
import { RunnerControlService, type InstanceRunnerLimits as Policy } from './gen/golf/v1/golf_pb';
import { DateLabel, Loading, PanelError } from './RepositoryUI';
import { usePoolPanel } from './RunnerPools';
import { limitsDraft, limitsFromDraft, RunnerJobLimitFields, RunnerLimitSummary, sameJobLimits, validJobLimits, type RunnerLimitValues } from './RunnerJobLimits';

type Context = { client: Client<typeof RunnerControlService>; userId: string; signingOut: boolean; revalidating: boolean };
export function validInstanceRunnerLimits(p: Policy | undefined): p is Policy {
  return Boolean(p && /^(0|[1-9][0-9]{0,18})$/.test(p.version) && BigInt(p.version) <= 9223372036854775807n && validJobLimits(p.limits) && p.updatedAt.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(p.updatedAt) && Number.isFinite(Date.parse(p.updatedAt)));
}
function LimitEditor({ policy, close, save }: { policy: Policy; close: () => void; save: (limits: RunnerLimitValues, password: string) => void }) {
  const id = useId(), password = useRef<HTMLInputElement>(null);
  const form = useForm({ defaultValues: { limits: limitsDraft(policy.limits!), password: '' }, validators: { onSubmit: ({ value }) => !limitsFromDraft(value.limits) ? 'Use all four supported resource limits with canonical memory bytes.' : !value.password ? 'Enter your current Golf password.' : undefined }, onSubmit: ({ value }) => { save(limitsFromDraft(value.limits)!, value.password); form.reset(); } });
  useEffect(() => { password.current?.focus(); }, []);
  const cancel = () => { if (form.state.isDirty && !window.confirm('Discard unsaved instance resource limits?')) return; close(); };
  return <section className="browser-panel"><div className="browser-panel-heading"><h3>Edit instance job resource limits</h3><button type="button" className="icon-button" aria-label="Close resource limit editor" onClick={cancel}><X size={16} /></button></div>
    <form className="credential-form-content" aria-label="Edit instance job resource limits" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <p className="field-help">Current configuration version {policy.version}. Changes invalidate queued resource bindings; inspect and explicitly dispatch new work. Running attempts keep their admitted limits. These are execution ceilings, not measured CPU, memory or worker health.</p>
      <form.Field name="limits">{field => <RunnerJobLimitFields value={field.state.value} change={(name, value) => field.handleChange({ ...field.state.value, [name]: value })} />}</form.Field>
      <form.Field name="password">{field => <><label htmlFor={id}>Current Golf password</label><input id={id} ref={password} type="password" autoComplete="current-password" required value={field.state.value} onChange={e => field.handleChange(e.target.value)} /></>}</form.Field>
      <form.Subscribe selector={s => s.errors}>{errors => errors.length ? <p className="error" role="alert">{errors.join(' ')}</p> : null}</form.Subscribe>
      <div className="credential-actions"><button type="submit" className="button primary">Save instance limits</button><button type="button" className="button secondary" onClick={cancel}>Cancel</button></div>
    </form></section>;
}
export function InstanceRunnerLimits(props: Context) {
  const scope = JSON.stringify(['instance-limits', props.userId]), queries = useQueryClient();
  const panel = usePoolPanel(props, scope, true, async signal => { const r = await props.client.getInstanceRunnerLimits({}, { signal, timeoutMs: 15_000 }); if (!validInstanceRunnerLimits(r.policy)) throw new ConnectError('Instance resource limits could not be verified.', Code.Internal); return r.policy; });
  const [editor, edit] = useState<Policy | null>(null);
  useEffect(() => { if (!panel.visible) edit(null); }, [panel.visible]);
  const policy = panel.query.data;
  function save(limits: RunnerLimitValues, password: string) {
    if (!editor || !panel.visible) return;
    const frozen = editor; edit(null);
    void panel.mutate(async signal => {
      const r = await props.client.setInstanceRunnerLimits({ expectedVersion: frozen.version, limits, currentPassword: password }, { signal, timeoutMs: 15_000 });
      if (!validInstanceRunnerLimits(r.policy) || r.policy.version !== String(BigInt(frozen.version) + 1n) || !sameJobLimits(r.policy.limits, limits) || Date.parse(r.policy.updatedAt) < Date.parse(frozen.updatedAt)) throw new ConnectError('The instance resource-limit acknowledgement could not be verified.', Code.Internal);
    }).then(acknowledged => { if (acknowledged) void queries.invalidateQueries({ predicate: query => query.queryKey[0] === 'runner-pools' && query.queryKey[1] === props.userId && query.queryKey[2] !== scope }); });
  }
  return <div className="page-stack"><section className="browser-panel"><div className="browser-panel-heading"><h2>Instance job resource limits</h2><div className="credential-actions"><button type="button" className="icon-button" aria-label="Edit instance job resource limits" disabled={!panel.visible || panel.pending || panel.uncertain || Boolean(editor)} onClick={() => edit(policy!)}><Pencil size={16} /></button><button type="button" className="icon-button" aria-label="Inspect current instance resource limits" disabled={!panel.enabled || panel.pending || panel.query.isFetching} onClick={() => void panel.inspect()}><RefreshCw size={16} /></button></div></div>
    <p className="field-help">Instance ceilings apply to local Docker jobs. Pool and repository settings can restrict them further; whole-attempt time is shared across jobs. Kubernetes and Cloudflare resource profiles remain separate capabilities.</p>
    {panel.query.isPending && panel.enabled && <Loading label="Loading instance resource limits…" />}{panel.blocked && <p className="error" role="alert">Instance resource limits are unavailable with your current administrator access.</p>}{panel.query.error && !panel.blocked && <PanelError error={panel.query.error} retry={() => void panel.inspect()} />}
    {panel.visible && policy && <><RunnerLimitSummary requested={policy.limits!} effective={policy.limits!} label="Instance job resource ceilings" /><dl className="settings-profile"><div><dt>Configuration version</dt><dd>{policy.version}</dd></div><div><dt>Updated</dt><dd><DateLabel value={policy.updatedAt} /></dd></div></dl></>}{panel.visible && panel.notice && <p className="field-help" role="status">{panel.notice}</p>}
    </section>{editor && panel.visible && <LimitEditor policy={editor} close={() => edit(null)} save={save} />}</div>;
}
