import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { capabilityClient, errorMessage } from './api';
import { CapabilityState } from './gen/golf/v1/golf_pb';
import type { Capability } from './gen/golf/v1/golf_pb';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';

type StatusRow = Capability & { availability: string };
const columns: DataTableColumn<StatusRow>[] = [
  { accessorKey: 'label', header: 'Function' },
  { accessorKey: 'availability', header: 'Availability', cell: ({ row }) => <span className={`visibility ${row.original.state === CapabilityState.READY ? 'available' : row.original.state === CapabilityState.DEGRADED ? 'configured' : ''}`}><span className="status-dot" aria-hidden="true" />{row.original.availability}</span> },
  { accessorKey: 'reason', header: 'Current state' },
];
const groups = [
  { id: 'platform', title: 'Golf platform', description: 'Shared capabilities work with portable backends. Each function reports its current implementation and readiness.' },
  { id: 'agents', title: 'Coding agents', description: 'Agent runners can be your workstation, server, Docker or Kubernetes. Cloudflare is optional. Installed tools alone do not establish a connected Golf adapter.' },
  { id: 'cloudflare', title: 'Cloudflare integrations', description: 'Optional provider implementations are listed separately by function. A configured credential does not establish a verified connection or operational service.' },
];
function groupFor(id: string) {
  return id === 'agents' || id.startsWith('agents.') ? 'agents' : id === 'cloudflare' || id.startsWith('cloudflare.') ? 'cloudflare' : 'platform';
}
export function Capabilities() {
  const query = useQuery({ queryKey: ['capabilities'], queryFn: () => capabilityClient.listCapabilities({}) });
  const rows: StatusRow[] = query.isError ? [] : (query.data?.capabilities ?? []).map(row => ({ ...row, availability: row.state === CapabilityState.DEGRADED ? 'configured · degraded' : CapabilityState[row.state]?.toLowerCase() || 'unknown' }));
  return <section className="capabilities-section" id="capabilities" aria-labelledby="capabilities-title">
    <div className="section-heading"><div><span className="eyebrow">A CLEAR VIEW OF WHAT’S AVAILABLE</span><h2 id="capabilities-title">Your workspace today</h2></div><button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} />Refresh status</button></div>
    <p className="section-description">Availability comes directly from this Golf installation. Configuration, connection verification and successful execution are separate evidence.</p>
    {query.error ? <div className="error-message" role="alert">{errorMessage(query.error)}</div> : null}
    {query.isPending ? <p role="status" className="muted">Loading capabilities…</p> : null}
    {query.isSuccess ? <div className="capability-groups">{groups.map(group => <section key={group.id} aria-labelledby={`capabilities-${group.id}`}>
      <div className="section-heading"><h3 id={`capabilities-${group.id}`}>{group.title}</h3></div><p className="section-description">{group.description}</p>
      <DataTable label={group.title} data={rows.filter(row => groupFor(row.id) === group.id)} columns={columns} pagination={false} getRowId={row => row.id} emptyMessage="No capability information was reported for this section." />
    </section>)}</div> : null}
  </section>;
}
