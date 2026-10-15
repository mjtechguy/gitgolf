import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { Link } from '@tanstack/react-router';
import { nativeAPI } from './nativeAPI';
import { DateLabel } from './RepositoryUI';
import { AuditLog } from './AuditLog';

// Mirrors installationPolicies in cloudflare/forge/src/installation.mjs. The Worker re-validates every value and decides what widens.
type Value = { origins?: string[]; dailyLimit?: number; enabled?: boolean; lifetimeSeconds?: number; concurrency?: number } & Partial<Record<BudgetKey, number>>;
// Agent rate budgets (cloudflare/forge/src/agent-budgets.mjs): per-minute limits for each API token and each agent task.
type BudgetKey = 'tokenRequestsPerMinute' | 'tokenWritesPerMinute' | 'taskRequestsPerMinute' | 'taskWritesPerMinute';
const budgetFields: [BudgetKey, string][] = [['tokenRequestsPerMinute', 'API token requests a minute'], ['tokenWritesPerMinute', 'API token writes a minute'], ['taskRequestsPerMinute', 'Agent task requests a minute'], ['taskWritesPerMinute', 'Agent task writes a minute']];
export type InstallationPolicy = { key: string; label: string; version: string; value: Value; deploy: Value; source: 'deploy' | 'installation'; unreadable: boolean; updatedAt: string; updatedBy: string;
  bounds: Record<string, [number, number] | string>; effect: { queued: string; inFlight: string; new: string }; confirmation: string };
export type AuditEntry = { id: string; at: string; actor: string; actorEmail: string; scope: string; scopeId: string; subject: string; action: string; before: unknown; after: unknown; widening: boolean; client: { colo?: string; country?: string } };
type Draft = { origins: string; dailyLimit: string; enabled: boolean; lifetimeMinutes: string; concurrency: string; confirmation: string } & Record<BudgetKey, string>;

const toggles: Record<string, string> = { email: 'Send email notifications', advice: 'Allow AI advice', agents: 'Allow agent proposals', 'rate-limit': 'Limit anonymous reads and clones', 'agent-budgets': 'Refuse requests over these budgets' };
const number = (text: string) => /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : NaN;
function valueOf(key: string, draft: Draft): Value {
  if (key === 'webhooks') return { origins: draft.origins.split('\n').map(line => line.trim()).filter(Boolean), dailyLimit: number(draft.dailyLimit) };
  if (key === 'email') return { enabled: draft.enabled, dailyLimit: number(draft.dailyLimit) };
  if (key === 'previews') return { lifetimeSeconds: number(draft.lifetimeMinutes) * 60, concurrency: number(draft.concurrency) };
  if (key === 'evidence') return { dailyLimit: number(draft.dailyLimit) };
  if (key === 'agent-budgets') return { enabled: draft.enabled, ...Object.fromEntries(budgetFields.map(([name]) => [name, number(draft[name])])) };
  return { enabled: draft.enabled };
}
// Shown so the person knows a confirmation is coming; the Worker makes the same decision and refuses without it.
function widens(key: string, before: Value, after: Value) {
  if (key === 'rate-limit') return Boolean(before.enabled && !after.enabled);
  if (key === 'agent-budgets') return Boolean(before.enabled && !after.enabled) || budgetFields.some(([name]) => (after[name] ?? 0) > (before[name] ?? Infinity));
  return Boolean(after.enabled && !before.enabled || (after.origins || []).some(origin => !(before.origins || []).includes(origin)) ||
    (after.dailyLimit ?? 0) > (before.dailyLimit ?? Infinity) || (after.lifetimeSeconds ?? 0) > (before.lifetimeSeconds ?? Infinity) || (after.concurrency ?? 0) > (before.concurrency ?? Infinity));
}
export const policyText = (key: string, value: Value) => key === 'webhooks' ? `${value.origins?.length} origins · ${value.dailyLimit} attempts a day`
  : key === 'email' ? `${value.enabled ? 'On' : 'Off'} · ${value.dailyLimit} attempts a day` : key === 'previews' ? `${Math.round((value.lifetimeSeconds || 0) / 60)} minutes · ${value.concurrency} at once`
  : key === 'evidence' ? `${value.dailyLimit} a day`
  : key === 'agent-budgets' ? `${value.enabled ? 'On' : 'Off'} · tokens ${value.tokenRequestsPerMinute}/${value.tokenWritesPerMinute} · tasks ${value.taskRequestsPerMinute}/${value.taskWritesPerMinute} requests/writes a minute`
  : value.enabled ? 'On' : 'Off';

export function PolicyPanel({ policy, editable, onSaved }: { policy: InstallationPolicy; editable: boolean; onSaved: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false), [operationId, setOperationId] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const v = policy.value, bound = (name: string) => policy.bounds[name] as [number, number] | undefined;
  const form = useForm({ defaultValues: { origins: (v.origins || []).join('\n'), dailyLimit: String(v.dailyLimit ?? ''), enabled: v.enabled ?? true, lifetimeMinutes: String(Math.round((v.lifetimeSeconds || 0) / 60)), concurrency: String(v.concurrency ?? ''), confirmation: '',
    ...Object.fromEntries(budgetFields.map(([name]) => [name, String(v[name] ?? '')])) } as Draft,
    onSubmit: async ({ value: draft }) => {
      setPending(true); setError('');
      try {
        // The same operation ID is reused if this attempt's outcome is unknown, so a retry cannot apply the change twice.
        await nativeAPI('/native/installation', { action: 'update', key: policy.key, expectedVersion: policy.version, operationId, value: valueOf(policy.key, draft), ...(draft.confirmation ? { confirmation: draft.confirmation } : {}) });
        setOpen(false); await onSaved();
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Refresh before trying again.'); }
      finally { setPending(false); }
    } });
  // Mid-sentence label that keeps acronyms such as AI.
  const label = /^[A-Z]{2}/.test(policy.label) ? policy.label : policy.label.charAt(0).toLowerCase() + policy.label.slice(1);
  // Agent rate budgets have no deploy allocation: built-in defaults, any value in bounds.
  const builtIn = policy.key === 'agent-budgets';
  return <div className="settings-policy">
    <div className="settings-policy-current"><span><strong>{policy.source === 'installation' ? 'Set here' : builtIn ? 'Built-in default' : 'Deploy value'}</strong>{policy.source === 'installation' ? <> by {policy.updatedBy || 'an administrator'} <DateLabel value={policy.updatedAt} relative /> · {builtIn ? 'built-in default' : 'deploy value'} {policyText(policy.key, policy.deploy)}</> : builtIn ? ' · editable here' : ' · editable within the deploy allocation'}</span>
      {editable && !open ? <button type="button" className="button secondary" aria-label={`Edit ${label}`} onClick={() => { setOpen(true); setError(''); setOperationId(crypto.randomUUID()); form.reset(); }}>Edit</button> : null}</div>
    {policy.unreadable ? <p className="error" role="alert">The saved value could not be read; the deploy value applies until it is saved again.</p> : null}
    {open ? <form className="credential-form-content settings-policy-form" aria-label={`Edit ${label}`} onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      {policy.key === 'webhooks' ? <form.Field name="origins">{field => <label>Approved origins<textarea rows={Math.min(8, Math.max(3, field.state.value.split('\n').length + 1))} required disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} spellCheck={false} />
        <span className="field-help">One HTTPS origin per line, such as <code>https://hooks.example.com</code>. {String(policy.bounds.origins)}</span></label>}</form.Field> : null}
      {toggles[policy.key] ? <form.Field name="enabled">{field => <label className="checkbox-field"><input type="checkbox" disabled={pending} checked={field.state.value} onChange={event => field.handleChange(event.target.checked)} />{toggles[policy.key]}</label>}</form.Field> : null}
      {bound('dailyLimit') ? <form.Field name="dailyLimit">{field => <label>{policy.key === 'evidence' ? 'Admissions a day' : policy.key === 'email' ? 'Send attempts a day' : 'Delivery attempts a day'}<input type="number" inputMode="numeric" min={bound('dailyLimit')![0]} max={bound('dailyLimit')![1]} required disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
        <span className="field-help">{bound('dailyLimit')![0]} to {bound('dailyLimit')![1]}{policy.key === 'evidence' ? ' (the deploy value is the ceiling)' : ''}.</span></label>}</form.Field> : null}
      {policy.key === 'previews' ? <><form.Field name="lifetimeMinutes">{field => <label>Lifetime in minutes<input type="number" inputMode="numeric" min={1} max={Math.floor(bound('lifetimeSeconds')![1] / 60)} required disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
          <span className="field-help">1 to {Math.floor(bound('lifetimeSeconds')![1] / 60)}; the deploy lifetime is the ceiling.</span></label>}</form.Field>
        <form.Field name="concurrency">{field => <label>Previews held at once<input type="number" inputMode="numeric" min={1} max={bound('concurrency')![1]} required disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
          <span className="field-help">1 to {bound('concurrency')![1]} installation slots.</span></label>}</form.Field></> : null}
      {builtIn ? budgetFields.map(([name, text]) => <form.Field key={name} name={name}>{field => <label>{text}<input type="number" inputMode="numeric" min={bound(name)![0]} max={bound(name)![1]} required disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
        <span className="field-help">{bound(name)![0]} to {bound(name)![1].toLocaleString('en-US')}.</span></label>}</form.Field>) : null}
      <dl className="settings-profile settings-policy-effect"><div><dt>Queued work</dt><dd>{policy.effect.queued}</dd></div><div><dt>In flight</dt><dd>{policy.effect.inFlight}</dd></div><div><dt>New work</dt><dd>{policy.effect.new}</dd></div></dl>
      <form.Subscribe selector={state => state.values}>{draft => widens(policy.key, policy.value, valueOf(policy.key, draft)) ? <form.Field name="confirmation">{field => <label>Type <code>{policy.confirmation}</code> to widen {label}
        <input autoComplete="off" spellCheck={false} disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
        <span className="field-help">Widening also needs an Access sign-in from the last 10 minutes.</span></label>}</form.Field> : null}</form.Subscribe>
      {error ? <p className="error" role="alert">{error}{/last 10 minutes/.test(error) ? <> <a href="/cdn-cgi/access/logout">Sign out of Access</a>, sign in again, then save.</> : null}</p> : null}
      <div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending ? 'Saving…' : `Save ${label}`}</button><button type="button" className="button secondary" disabled={pending} onClick={() => { setOpen(false); setError(''); }}>Cancel</button></div>
    </form> : null}
  </div>;
}

const subjects: Record<string, string> = { webhooks: 'Webhooks', email: 'Email notifications', advice: 'AI advice', agents: 'Agent proposals', previews: 'Protected previews', 'rate-limit': 'Anonymous rate limit', evidence: 'Daily evidence admissions', 'agent-budgets': 'Agent rate budgets' };
const subjectLabel = (subject: string) => subjects[subject] || subject;
const describe = (subject: string, value: unknown) => subjects[subject] && value && typeof value === 'object' ? subject === 'webhooks' ? `${(value as Value).origins?.join(', ')} · ${(value as Value).dailyLimit} attempts a day` : policyText(subject, value as Value) : change(value);
const change = (value: unknown) => value === null || value === undefined ? '—' : typeof value === 'object' ? Object.entries(value as Record<string, unknown>).map(([name, item]) => `${name}: ${Array.isArray(item) ? item.join(', ') : String(item)}`).join(' · ') : String(value);
export function RecentChanges({ entries }: { entries: AuditEntry[] }) {
  return <section className="browser-panel" aria-labelledby="installation-recent-title"><div className="browser-panel-heading"><h2 id="installation-recent-title">Recent changes</h2><Link className="text-button" to="/admin/audit">Open the audit log</Link></div>
    {entries.length ? <ul className="settings-attention-list">{entries.map(entry => <li key={entry.id}><strong>{subjectLabel(entry.subject)} · {entry.widening ? 'widened' : 'changed'} by {entry.actor || entry.actorEmail}</strong><span>{describe(entry.subject, entry.after)}</span>
      <small><DateLabel value={entry.at} relative />{entry.client.colo ? ` · from ${entry.client.colo}${entry.client.country ? ', ' + entry.client.country : ''}` : ''} · was {describe(entry.subject, entry.before)}</small></li>)}</ul>
      : <p className="panel-footnote">No installation policy has been changed here; every value is the deploy value.</p>}
  </section>;
}

// The installation audit log is the shared audit log at installation scope.
export function InstallationAudit({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  return <AuditLog scope={{ kind: 'installation' }} userId={userId} signingOut={signingOut} />;
}
