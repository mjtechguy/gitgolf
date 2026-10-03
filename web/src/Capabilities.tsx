import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
function setupAction(row: StatusRow, isInstanceAdmin: boolean) {
  if (row.id === 'agents.codex') return <div><Link className="text-button" to="/account/agents">Manage Codex connection</Link><p className="field-help">Personal authentication setup; model access and task execution are separate.</p></div>;
  if (row.id === 'repositories') return <Link className="text-button" to="/">Manage repositories</Link>;
  if (row.id === 'pipelines') return isInstanceAdmin ? <Link className="text-button" to="/admin/execution">Manage policies</Link> : <span className="muted">Ask an instance administrator about worker setup</span>;
  if (row.id === 'events.native') return <span className="muted">Configured in deployment; UI setup unavailable</span>;
  if (row.id === 'cloudflare.r2' || row.id === 'cloudflare.r2.sources') return isInstanceAdmin ? <div><Link className="text-button" to="/admin/settings/infrastructure">Configure source storage</Link><p className="field-help">Other R2 consumers and live Cloudflare qualification remain unavailable.</p></div> : <span className="muted">Source storage requires an instance administrator</span>;
  return <span className="muted">Setup not available yet</span>;
}
function groupFor(id: string) {
  return id === 'agents' || id.startsWith('agents.') ? 'agents' : id === 'cloudflare' || id.startsWith('cloudflare.') ? 'cloudflare' : 'platform';
}
export function Capabilities({ isInstanceAdmin }: { isInstanceAdmin: boolean }) {
  const query = useQuery({ queryKey: ['capabilities'], queryFn: () => capabilityClient.listCapabilities({}) });
  const rows: StatusRow[] = query.isError ? [] : (query.data?.capabilities ?? []).map(row => ({ ...row, availability: row.state === CapabilityState.DEGRADED ? 'configured · degraded' : CapabilityState[row.state]?.toLowerCase() || 'unknown' }));
  const setupColumns: DataTableColumn<StatusRow>[] = [...columns, { id: 'setup', header: 'Configuration', enableSorting: false, enableGlobalFilter: false, cell: ({ row }) => setupAction(row.original, isInstanceAdmin) }];
  return <section className="capabilities-section" id="capabilities" aria-labelledby="capabilities-title">
    <div className="section-heading"><div><span className="eyebrow">A CLEAR VIEW OF WHAT’S AVAILABLE</span><h2 id="capabilities-title">Your workspace today</h2></div><button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} />Refresh status</button></div>
    <p className="section-description">Availability comes directly from this Golf installation. Configuration, connection verification and successful execution are separate evidence.</p>
    {query.error ? <div className="error-message" role="alert">{errorMessage(query.error)}</div> : null}
    {query.isPending ? <p role="status" className="muted">Loading capabilities…</p> : null}
    {query.isSuccess ? <><section className="browser-panel" aria-labelledby="connection-setup-title"><div className="browser-panel-heading"><h3 id="connection-setup-title">Database and storage connections</h3>{isInstanceAdmin ? <Link className="button secondary" to="/admin/settings/infrastructure">Manage connections</Link> : null}</div><p className="panel-footnote">{isInstanceAdmin ? 'Add a PostgreSQL, RustFS, S3 or R2 profile, then test it. Multiple profiles can be saved. One storage binding is active for future CI sources; existing runs retain their original version. Database profiles can be saved and tested, but live database cutover is not available.' : 'Instance administrators manage database and storage connections. Repository owners manage workflow policies and automation grants in repository settings.'}</p></section><div className="capability-groups">{groups.map(group => <section key={group.id} aria-labelledby={`capabilities-${group.id}`}>
      <div className="section-heading"><h3 id={`capabilities-${group.id}`}>{group.title}</h3></div><p className="section-description">{group.description}</p>
      <DataTable label={group.title} data={rows.filter(row => groupFor(row.id) === group.id)} columns={setupColumns} pagination={false} getRowId={row => row.id} emptyMessage="No capability information was reported for this section." />
    </section>)}</div></> : null}
  </section>;
}
