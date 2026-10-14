import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';

// Mirrors installationPolicies in cloudflare/forge/src/installation.mjs. The Worker re-validates every value and decides what widens.
type Value = { origins?: string[]; dailyLimit?: number; enabled?: boolean; lifetimeSeconds?: number; concurrency?: number };
export type InstallationPolicy = { key: string; label: string; version: string; value: Value; deploy: Value; source: 'deploy' | 'installation'; unreadable: boolean; updatedAt: string; updatedBy: string;
  bounds: Record<string, [number, number] | string>; effect: { queued: string; inFlight: string; new: string }; confirmation: string };
export type AuditEntry = { id: string; at: string; actor: string; actorEmail: string; scope: string; scopeId: string; subject: string; action: string; before: unknown; after: unknown; widening: boolean; client: { colo?: string; country?: string } };
type Draft = { origins: string; dailyLimit: string; enabled: boolean; lifetimeMinutes: string; concurrency: string; confirmation: string };

const toggles: Record<string, string> = { email: 'Send email notifications', advice: 'Allow AI advice', agents: 'Allow agent proposals', 'rate-limit': 'Limit anonymous reads and clones' };
const number = (text: string) => /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : NaN;
function valueOf(key: string, draft: Draft): Value {
  if (key === 'webhooks') return { origins: draft.origins.split('\n').map(line => line.trim()).filter(Boolean), dailyLimit: number(draft.dailyLimit) };
  if (key === 'email') return { enabled: draft.enabled, dailyLimit: number(draft.dailyLimit) };
  if (key === 'previews') return { lifetimeSeconds: number(draft.lifetimeMinutes) * 60, concurrency: number(draft.concurrency) };
  if (key === 'evidence') return { dailyLimit: number(draft.dailyLimit) };
  return { enabled: draft.enabled };
}
// Shown so the person knows a confirmation is coming; the Worker makes the same decision and refuses without it.
function widens(key: string, before: Value, after: Value) {
  if (key === 'rate-limit') return Boolean(before.enabled && !after.enabled);
  return Boolean(after.enabled && !before.enabled || (after.origins || []).some(origin => !(before.origins || []).includes(origin)) ||
    (after.dailyLimit ?? 0) > (before.dailyLimit ?? Infinity) || (after.lifetimeSeconds ?? 0) > (before.lifetimeSeconds ?? Infinity) || (after.concurrency ?? 0) > (before.concurrency ?? Infinity));
}
export const policyText = (key: string, value: Value) => key === 'webhooks' ? `${value.origins?.length} origins · ${value.dailyLimit} attempts a day`
  : key === 'email' ? `${value.enabled ? 'On' : 'Off'} · ${value.dailyLimit} attempts a day` : key === 'previews' ? `${Math.round((value.lifetimeSeconds || 0) / 60)} minutes · ${value.concurrency} at once`
  : key === 'evidence' ? `${value.dailyLimit} a day` : value.enabled ? 'On' : 'Off';

export function PolicyPanel({ policy, editable, onSaved }: { policy: InstallationPolicy; editable: boolean; onSaved: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false), [operationId, setOperationId] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const v = policy.value, bound = (name: string) => policy.bounds[name] as [number, number] | undefined;
  const form = useForm({ defaultValues: { origins: (v.origins || []).join('\n'), dailyLimit: String(v.dailyLimit ?? ''), enabled: v.enabled ?? true, lifetimeMinutes: String(Math.round((v.lifetimeSeconds || 0) / 60)), concurrency: String(v.concurrency ?? ''), confirmation: '' } as Draft,
    onSubmit: async ({ value: draft }) => {
      setPending(true); setError('');
      try {
        // The same operation ID is reused if this attempt's outcome is unknown, so a retry cannot apply the change twice.
        await nativeAPI('/native/installation', { action: 'update', key: policy.key, expectedVersion: policy.version, operationId, value: valueOf(policy.key, draft), ...(draft.confirmation ? { confirmation: draft.confirmation } : {}) });
        setOpen(false); await onSaved();
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be confirmed. Refresh before trying again.'); }
      finally { setPending(false); }
    } });
  const label = policy.label.toLowerCase();
  return <div className="settings-policy">
    <div className="settings-policy-current"><span><strong>{policy.source === 'installation' ? 'Set here' : 'Deploy value'}</strong>{policy.source === 'installation' ? <> by {policy.updatedBy || 'an administrator'} <DateLabel value={policy.updatedAt} relative /> · deploy value {policyText(policy.key, policy.deploy)}</> : ' · editable within the deploy allocation'}</span>
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
      <dl className="settings-profile settings-policy-effect"><div><dt>Queued work</dt><dd>{policy.effect.queued}</dd></div><div><dt>In flight</dt><dd>{policy.effect.inFlight}</dd></div><div><dt>New work</dt><dd>{policy.effect.new}</dd></div></dl>
      <form.Subscribe selector={state => state.values}>{draft => widens(policy.key, policy.value, valueOf(policy.key, draft)) ? <form.Field name="confirmation">{field => <label>Type <code>{policy.confirmation}</code> to widen {label}
        <input autoComplete="off" spellCheck={false} disabled={pending} value={field.state.value} onChange={event => field.handleChange(event.target.value)} />
        <span className="field-help">Widening also needs an Access sign-in from the last 10 minutes.</span></label>}</form.Field> : null}</form.Subscribe>
      {error ? <p className="error" role="alert">{error}{/last 10 minutes/.test(error) ? <> <a href="/cdn-cgi/access/logout">Sign out of Access</a>, sign in again, then save.</> : null}</p> : null}
      <div className="credential-actions"><button type="submit" className="button primary" disabled={pending}>{pending ? 'Saving…' : `Save ${label}`}</button><button type="button" className="button secondary" disabled={pending} onClick={() => { setOpen(false); setError(''); }}>Cancel</button></div>
    </form> : null}
  </div>;
}

const subjects: Record<string, string> = { webhooks: 'Webhooks', email: 'Email notifications', advice: 'AI advice', agents: 'Agent proposals', previews: 'Protected previews', 'rate-limit': 'Anonymous rate limit', evidence: 'Daily evidence admissions' };
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

const auditColumns: DataTableColumn<AuditEntry>[] = [
  { id: 'at', header: 'When', accessorFn: row => row.at, cell: ({ row }) => <DateLabel value={row.original.at} /> },
  { id: 'actor', header: 'Who', accessorFn: row => `${row.actor} ${row.actorEmail}`, cell: ({ row }) => <><strong>{row.original.actor || 'Unknown account'}</strong><small>{row.original.actorEmail}</small></> },
  { id: 'subject', header: 'Setting', accessorFn: row => `${row.scope} ${row.scopeId} ${row.subject}`, cell: ({ row }) => <><strong>{subjectLabel(row.original.subject)}</strong><small>{row.original.scope}{row.original.scopeId ? ' · ' + row.original.scopeId : ''}</small></> },
  { id: 'change', header: 'Change', accessorFn: row => `${describe(row.subject, row.before)} ${describe(row.subject, row.after)}`, cell: ({ row }) => <><span>{describe(row.original.subject, row.original.after)}</span><small>was {describe(row.original.subject, row.original.before)}</small></> },
  { id: 'widening', header: 'Kind', accessorFn: row => row.widening ? 'Widening' : 'Narrowing or equal', cell: ({ row }) => <span className={`visibility ${row.original.widening ? 'configured' : ''}`}>{row.original.widening ? 'Widening' : 'Narrowing or same'}</span> },
  { id: 'from', header: 'From', accessorFn: row => [row.client.colo, row.client.country].filter(Boolean).join(', ') || 'Not recorded' },
];
export function InstallationAudit({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const query = useInfiniteQuery({ ...privateQuery, queryKey: ['installation-audit', userId], enabled: !signingOut, retry: false, initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => nativeAPI<{ entries: AuditEntry[]; page: { nextPage: number } }>('/native/installation/read', { action: 'audit', page: { page: pageParam, limit: 50 } }, signal),
    getNextPageParam: (last, _pages, current) => last.page.nextPage > current ? last.page.nextPage : undefined });
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <Loading label="Reading the audit log…" />;
  const entries = query.data.pages.flatMap(page => page.entries);
  return <>
    <div className="settings-toolbar"><span className="field-help">Entries cannot be edited or removed through Golf. Newest first; {entries.length} loaded.</span><button className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} />Refresh</button></div>
    <section className="browser-panel" aria-labelledby="installation-audit-title"><div className="browser-panel-heading"><h2 id="installation-audit-title">Policy changes</h2></div>
      <DataTable data={entries} columns={auditColumns} getRowId={row => row.id} label="Installation audit log" emptyMessage="No installation policy has been changed yet." />
      <div className="list-footer"><span>{entries.length} loaded</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="entries" /></div></section>
  </>;
}
