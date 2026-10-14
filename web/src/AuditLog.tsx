import { useId, useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { repositoryOptions } from './navigation';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, More, PanelError, privateQuery } from './RepositoryUI';

// Mirrors the /native/audit/read contract in cloudflare/forge. The Worker decides who may read which scope and filters the whole log.
export type AuditScope = { kind: 'installation' } | { kind: 'repository'; owner: string; name: string } | { kind: 'organization'; organization: string };
export type AuditOutcome = 'success' | 'denied' | 'refused' | 'unknown';
export type AuditEvent = {
  id: string; at: string; action: string; category: string; categoryLabel: string; description: string;
  actor: string; actorEmail: string; actorKind: 'person' | 'token' | 'service' | 'git' | 'anonymous'; serviceToken?: string;
  scope: 'installation' | 'organization' | 'repository'; scopeId: string; repository: string; organization: string;
  subject: string; before: unknown; after: unknown; widening: boolean; outcome: AuditOutcome; code: string;
  client: { colo?: string; country?: string; ip?: string; userAgent?: string; requestId?: string };
};
type AuditPage = { entries: AuditEvent[]; page: { nextPage: number }; categories: { id: string; label: string }[];
  recording: { failures: number; lastFailureAt: string }; scope: { kind: string; id: string; label: string } };
type Filters = { category: string; actor: string; repository: string; outcome: '' | AuditOutcome; from: string; to: string; query: string };
const none: Filters = { category: '', actor: '', repository: '', outcome: '', from: '', to: '', query: '' };

const outcomes: Record<AuditOutcome, [string, string]> = { success: ['Succeeded', 'available'], denied: ['Denied', 'refused'], refused: ['Refused', 'configured'], unknown: ['Outcome unknown', 'unallocated'] };
const scopeText = { installation: 'Installation', repository: 'Repository', organization: 'Organization' } as const;
const empty = { installation: 'Nothing has been recorded on this installation yet.', repository: 'Nothing has been recorded for this repository yet.', organization: 'Nothing has been recorded for this organization yet.' } as const;
const denied = { installation: 'Only operations administrators signed in through Access can read the installation audit log.', repository: 'Only administrators of this repository can read its audit log.', organization: 'Only owners of this organization can read its audit log.' } as const;

export const actorName = (entry: AuditEvent) => entry.actor || entry.actorEmail || (entry.actorKind === 'token' || entry.actorKind === 'service' ? entry.serviceToken ? `Service token ${entry.serviceToken}` : 'Service token' : entry.actorKind === 'anonymous' ? 'Anonymous visitor' : 'Unknown account');
const origin = (client: AuditEvent['client']) => [client.country, client.colo].filter(Boolean).join(' · ');
// The Worker records names and shapes, never secret values; a field that still looks like one is hidden here too.
const hidden = /^(value|token|password|secret|private_?key|credential)$/i;
const show = (key: string, value: unknown): string => value === null || value === undefined || value === '' ? '—' : hidden.test(key) ? 'Hidden' : Array.isArray(value) ? value.map(item => show('', item)).join(', ') || '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const fields = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : value === null || value === undefined ? {} : { state: value };

function Change({ before, after }: { before: unknown; after: unknown }) {
  const was = fields(before), now = fields(after), keys = [...new Set([...Object.keys(was), ...Object.keys(now)])];
  if (!keys.length) return <p className="audit-change-none">No values recorded.</p>;
  const created = before === null || before === undefined, removed = after === null || after === undefined;
  return <dl className="audit-change">{keys.map(key => <div key={key}><dt>{key}</dt><dd>
    {created ? <span className="audit-after">{show(key, now[key])}</span> : removed ? <span className="audit-before">{show(key, was[key])}</span>
      : show(key, was[key]) === show(key, now[key]) ? <span>{show(key, now[key])}</span>
      : <><span className="audit-before">{show(key, was[key])}</span><span className="audit-arrow" aria-label="changed to">→</span><span className="audit-after">{show(key, now[key])}</span></>}
  </dd></div>)}</dl>;
}

function Details({ entry }: { entry: AuditEvent }) {
  const before = entry.before !== null && entry.before !== undefined, after = entry.after !== null && entry.after !== undefined;
  const rows: [string, string][] = [['Actor', `${actorName(entry)} · ${entry.actorKind}`], ['Email', entry.actorEmail || '—'], ...(entry.serviceToken ? [['Service token', entry.serviceToken] as [string, string]] : []),
    ['Scope', `${entry.scope}${entry.scopeId ? ' · ' + entry.scopeId : ''}`], ['Subject', entry.subject || '—'], ...(entry.code ? [['Error code', entry.code] as [string, string]] : []),
    ['IP address', entry.client.ip || '—'], ['Location', origin(entry.client) || 'Not recorded'], ['User agent', entry.client.userAgent || '—'], ['Request', entry.client.requestId || '—']];
  return <details className="metadata-details audit-details"><summary>Details<span className="sr-only"> for {entry.action}</span></summary>
    <div className="audit-details-body">
      <section aria-label="Values"><h4>{before && after ? 'Before → after' : after ? 'Recorded values' : before ? 'Values before' : 'Values'}{entry.widening ? <span className="visibility configured">Widening</span> : null}</h4><Change before={entry.before} after={entry.after} /></section>
      <section aria-label="Request"><h4>Request</h4><dl className="audit-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === 'Error code' || label === 'Request' || label === 'IP address' ? <code>{value}</code> : value}</dd></div>)}</dl></section>
    </div></details>;
}

function columns(scope: AuditScope['kind']): DataTableColumn<AuditEvent>[] {
  return [
    { id: 'event', header: 'Event', accessorFn: row => `${actorName(row)} ${row.description} ${row.repository} ${row.action} ${row.categoryLabel}`, cell: ({ row: { original: entry } }) => {
      const [owner, name] = entry.repository.split('/');
      return <div className="audit-log-event"><p><strong>{actorName(entry)}</strong> {entry.description}{scope !== 'repository' && owner && name ? <> in <Link {...repositoryOptions({ owner, name })}>{entry.repository}</Link></> : null}</p>
        <p className="audit-event-meta"><code className="audit-action">{entry.action}</code><span>{entry.categoryLabel || entry.category}</span>{entry.widening ? <span className="visibility configured">Widening</span> : null}</p>
        <Details entry={entry} /></div>;
    } },
    { id: 'at', header: 'When', accessorFn: row => row.at, cell: ({ row }) => <DateLabel value={row.original.at} relative /> },
    { id: 'outcome', header: 'Outcome', accessorFn: row => (outcomes[row.outcome] || outcomes.unknown)[0], cell: ({ row }) => { const [label, tone] = outcomes[row.original.outcome] || outcomes.unknown; return <span className={`visibility ${tone}`}>{label}</span>; } },
    { id: 'from', header: 'From', accessorFn: row => origin(row.client) || 'Not recorded', cell: ({ row }) => origin(row.original.client) ? <span className="audit-origin" title={row.original.client.ip ? `IP ${row.original.client.ip}` : undefined}>{origin(row.original.client)}</span> : <span className="muted">Not recorded</span> },
  ];
}

const body = (scope: AuditScope) => scope.kind === 'repository' ? { scope: 'repository', repository: { owner: scope.owner, name: scope.name } } : scope.kind === 'organization' ? { scope: 'organization', organization: scope.organization } : { scope: 'installation' };
const applied = (filters: Filters, scope: AuditScope['kind']) => Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, value.trim()]).filter(([key, value]) => value && !(key === 'repository' && scope === 'repository')));

export function AuditLog({ scope, userId, signingOut }: { scope: AuditScope; userId: string; signingOut: boolean }) {
  const id = useId(), [filters, setFilters] = useState<Filters>(none), [formError, setFormError] = useState('');
  const active = applied(filters, scope.kind), activeCount = Object.keys(active).length;
  const query = useInfiniteQuery({ ...privateQuery, queryKey: ['audit-log', userId, body(scope), active], enabled: !signingOut, retry: false, initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => nativeAPI<AuditPage>('/native/audit/read', { ...body(scope), ...(activeCount ? { filters: active } : {}), page: { page: pageParam, limit: 50 } }, signal),
    getNextPageParam: (last, _pages, current) => last.page.nextPage > current ? last.page.nextPage : undefined });
  const form = useForm({ defaultValues: none, onSubmit: ({ value }) => {
    if (value.from && value.to && value.from > value.to) { setFormError('The From date must be on or before the To date.'); return; }
    if (value.repository.trim() && !/^[^/\s]+\/[^/\s]+$/.test(value.repository.trim())) { setFormError('Enter the repository as owner/name.'); return; }
    setFormError(''); setFilters({ ...value });
  } });
  const draft = useStore(form.store, state => state.values), changed = JSON.stringify(draft) !== JSON.stringify(filters);
  const first = query.data?.pages[0], categories = first?.categories || [], entries = query.data ? query.data.pages.flatMap(page => page.entries) : [];
  const recording = first?.recording, label = `${scopeText[scope.kind]} audit log`;
  const error = query.error ? query.error instanceof ConnectError && query.error.code === Code.PermissionDenied ? new Error(`${denied[scope.kind]} ${query.error.rawMessage}`.trim()) : query.error : null;
  const clear = () => { form.reset(); setFormError(''); setFilters(none); };
  const text = (name: 'actor' | 'repository' | 'query', title: string, placeholder: string, max: number) => <form.Field name={name}>{field => <label className={name === 'query' ? 'audit-filter-search' : name === 'actor' && scope.kind === 'repository' ? 'audit-filter-wide' : undefined}>{title}<input type={name === 'query' ? 'search' : 'text'} autoComplete="off" spellCheck={false} maxLength={max} placeholder={placeholder} value={field.state.value} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field>;
  return <div className="page-stack audit-log">
    <section className="browser-panel" aria-labelledby={`${id}-filters`}>
      <div className="browser-panel-heading"><h2 id={`${id}-filters`}>Filters{activeCount ? <span className="count-badge" aria-label={`${activeCount} active`}>{activeCount} active</span> : null}</h2></div>
      <form className="audit-filter-form" aria-label="Filter the audit log" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
        {text('query', 'Search', 'Action, subject or description', 100)}
        <form.Field name="category">{field => <label>Category<select value={field.state.value} onChange={event => field.handleChange(event.target.value)}><option value="">All categories</option>{categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>}</form.Field>
        {text('actor', 'Actor', 'Login or email', 254)}
        {scope.kind !== 'repository' ? text('repository', 'Repository', 'owner/name', 201) : null}
        <form.Field name="outcome">{field => <label>Outcome<select value={field.state.value} onChange={event => field.handleChange(event.target.value as Filters['outcome'])}><option value="">All outcomes</option><option value="success">Succeeded</option><option value="denied">Denied</option><option value="refused">Refused</option><option value="unknown">Outcome unknown</option></select></label>}</form.Field>
        <form.Field name="from">{field => <label>From<input type="date" value={field.state.value} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field>
        <form.Field name="to">{field => <label>To<input type="date" value={field.state.value} onChange={event => field.handleChange(event.target.value)} /></label>}</form.Field>
        {formError ? <p className="error" role="alert">{formError}</p> : null}
        <div className="audit-filter-actions"><p className="field-help">Filters search the whole log on the server, not only loaded entries. Dates are inclusive, in UTC.</p>
          <div className="credential-actions"><button type="button" className="button secondary" disabled={!activeCount && !changed} onClick={clear}>Clear</button><button type="submit" className="button primary" disabled={query.isFetching && !query.isFetchingNextPage}>Apply filters</button></div></div>
      </form>
    </section>
    {recording && recording.failures > 0 ? <p className="audit-recording-warning" role="status"><TriangleAlert size={16} aria-hidden="true" /><span>{recording.failures} audit {recording.failures === 1 ? 'record' : 'records'} could not be written in this Worker instance since it started{recording.lastFailureAt ? <> (last <DateLabel value={recording.lastFailureAt} relative />)</> : null}. The actions themselves completed.</span></p> : null}
    <section className="browser-panel" aria-labelledby={`${id}-events`}>
      <div className="browser-panel-heading"><h2 id={`${id}-events`}>Events</h2><span className="audit-heading-note">Entries cannot be edited or removed through Golf. Newest first.</span><button type="button" className="button secondary audit-refresh" disabled={query.isFetching || signingOut} onClick={() => void query.refetch()}><RefreshCw size={15} aria-hidden="true" />Refresh</button></div>
      {error ? <PanelError error={error} retry={() => void query.refetch()} /> : !query.data ? <Loading label="Reading the audit log…" /> : <>
        <DataTable data={entries} columns={columns(scope.kind)} getRowId={row => row.id} label={label} emptyMessage={activeCount ? 'No entries match these filters anywhere in the log.' : empty[scope.kind]} />
        <div className="list-footer"><span>{entries.length} loaded{activeCount ? ' · filtered' : ''}</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="entries" /></div></>}
    </section>
  </div>;
}
