import { useMemo } from 'react';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Code, ConnectError } from '@connectrpc/connect';
import { History, RefreshCw } from 'lucide-react';
import { auditClient } from './api';
import { AuditAction } from './gen/golf/v1/golf_pb';
import type { AuditEvent, ListAuditEventsResponse } from './gen/golf/v1/golf_pb';
import { Loading, More, PanelError, privateQuery } from './RepositoryUI';

type Cursor = { beforeId?: string; snapshotId?: string };
const validID = (value: string) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

// Keep opaque int64 IDs as strings; refuse a changed or non-advancing history boundary.
function checkedPage(page: ListAuditEventsResponse, cursor: Cursor) {
  const invalid = () => { throw new ConnectError('Account activity returned an inconsistent history page. Refresh to try again.', Code.Internal); };
  if (page.snapshotId && !validID(page.snapshotId) || cursor.snapshotId && page.snapshotId !== cursor.snapshotId) invalid();
  let previous = cursor.beforeId;
  for (const event of page.events) {
    if (!validID(event.id) || !page.snapshotId || BigInt(event.id) > BigInt(page.snapshotId) || previous && BigInt(event.id) >= BigInt(previous)) invalid();
    previous = event.id;
  }
  if (page.nextBeforeId && (!validID(page.nextBeforeId) || page.nextBeforeId !== page.events.at(-1)?.id)) invalid();
  return page;
}

const actionLabels: Partial<Record<AuditAction, string>> = {
  [AuditAction.SIGN_IN]: 'Signed in',
  [AuditAction.SIGN_OUT]: 'Signed out',
  [AuditAction.SESSION_REVOKED]: 'Session revoked',
  [AuditAction.OTHER_SESSIONS_REVOKED]: 'Other sessions revoked',
  [AuditAction.SESSION_REPLACED]: 'Session replaced',
};

function EventTime({ value }: { value: string }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? <span>Time unavailable</span> : <time dateTime={value} title={value}>{date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })}</time>;
}

const credentialLabel = (kind: string) => kind === 'oauth' ? 'Provider OAuth' : kind === 'pat' ? 'Provider access token' : kind === 'local' ? 'Golf password' : 'Golf session';

function EventDetails({ event }: { event: AuditEvent }) {
  return <details><summary>Event details</summary><dl className="audit-metadata">
    <div><dt>Event ID</dt><dd><code>{event.id}</code></dd></div>
    <div><dt>Operation ID</dt><dd><code>{event.operationId || 'Not recorded'}</code></dd></div>
    <div><dt>Actor session ID</dt><dd><code>{event.actorSessionId || 'Not recorded'}</code></dd></div>
    <div><dt>Target session ID</dt><dd><code>{event.targetSessionId || 'No individual target'}</code></dd></div>
    <div><dt>Sessions revoked</dt><dd>{String(event.revokedCount)}</dd></div>
    {event.expiresAt ? <div><dt>Session expiry</dt><dd><EventTime value={event.expiresAt} /></dd></div> : null}
  </dl></details>;
}

const activityColumns: DataTableColumn<AuditEvent>[] = [
  { id: 'action', header: 'Event', accessorFn: (event) => actionLabels[event.action] || 'Session event', cell: ({ row }) => <><strong>{actionLabels[row.original.action] || 'Session event'}</strong><p><code>{row.original.id}</code></p></> },
  { accessorKey: 'occurredAt', header: 'Time', cell: ({ row }) => <EventTime value={row.original.occurredAt} /> },
  { id: 'credential', header: 'Credential', accessorFn: (event) => credentialLabel(event.credentialKind) },
  { id: 'session', header: 'Session', accessorFn: (event) => `${event.actorSessionId} ${event.targetSessionId}`, cell: ({ row }) => <><code>{row.original.actorSessionId || 'Not recorded'}</code><p>Target: <code>{row.original.targetSessionId || 'No individual target'}</code></p></> },
  { id: 'metadata', header: 'Details', accessorFn: (event) => `${event.id} ${event.operationId} ${event.revokedCount} ${event.expiresAt}`, enableSorting: false, cell: ({ row }) => <EventDetails event={row.original} /> },
];

export function AccountActivity({ userId }: { userId: string }) {
  const client = useQueryClient();
  const queryKey = ['account-activity', userId];
  const query = useInfiniteQuery({
    ...privateQuery, queryKey, initialPageParam: {} as Cursor,
    // A loaded history keeps its snapshot until the user requests a fresh one.
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ pageParam, signal }) => checkedPage(await auditClient.listAuditEvents({ limit: 20, ...pageParam }, { signal, timeoutMs: 8_000 }), pageParam),
    getNextPageParam: (page): Cursor | undefined => page.nextBeforeId ? { beforeId: page.nextBeforeId, snapshotId: page.snapshotId } : undefined,
  });
  const refresh = () => { void client.resetQueries({ queryKey, exact: true }); };
  const loading = query.isPending || (query.isFetching && !query.isFetchingNextPage);
  const events = useMemo(() => query.isSuccess && !loading ? query.data.pages.flatMap((page) => page.events) : [], [query.isSuccess, query.data, loading]);
  return <div className="account-activity">
    <header className="repository-intro"><div><span className="eyebrow">YOUR GOLF ACCOUNT</span><h1><History size={29} />Account activity</h1><p>Successful sign-ins, sign-outs and session changes for your account.</p></div></header>
    <p className="organization-guidance">History begins when session activity recording is enabled on this installation. Earlier activity, failed sign-ins and changes made outside Golf are not included.</p>
    <section className="browser-panel" aria-labelledby="activity-title" aria-busy={query.isFetching}>
      <div className="browser-panel-heading"><h2 id="activity-title">Session history</h2><button className="button secondary" disabled={query.isFetching} onClick={refresh}><RefreshCw size={15} className={query.isFetching ? 'spin' : ''} />Refresh activity</button></div>
      {query.isError ? <PanelError error={query.error} retry={refresh} /> : loading ? <Loading label="Loading account activity…" /> : <>
        <DataTable label="Account activity" data={events} columns={activityColumns} getRowId={(event) => event.id} emptyMessage="No recorded account activity. New successful session events will appear after you refresh." />
        <div className="list-footer audit-footer"><span>{events.length} loaded {events.length === 1 ? 'event' : 'events'}</span><More hasMore={Boolean(query.hasNextPage)} loading={query.isFetching} load={() => void query.fetchNextPage()} label="activity" /></div>
        {events.length ? <p className="panel-footnote">Loaded newest first; table sorting and search apply only to loaded events. This history snapshot stays fixed while you load older events. Refresh to include new activity.</p> : null}
      </>}
    </section>
  </div>;
}
