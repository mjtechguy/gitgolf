import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { operationsClient } from './api';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { runtimeLabel } from './runtimeCapabilities';
import { metricValue } from './operationsMetrics';
import type { OperationsMetric, OperationsServiceStatus } from './gen/golf/v1/golf_pb';

const serviceColumns: DataTableColumn<OperationsServiceStatus>[] = [
  { accessorKey: 'label', header: 'Service' },
  { accessorKey: 'state', header: 'Status', cell: ({ row }) => <span className={`visibility ${row.original.state === 'available' ? 'available' : ''}`}>{row.original.state}</span> },
  { accessorKey: 'detail', header: 'Current observation' },
  { accessorKey: 'source', header: 'Source' },
  { accessorKey: 'checkedAt', header: 'Last checked', cell: ({ row }) => row.original.checkedAt ? <DateLabel value={row.original.checkedAt} /> : 'Not observed' },
];
const metricColumns: DataTableColumn<OperationsMetric>[] = [
  { accessorKey: 'label', header: 'Metric' },
  { id: 'value', header: 'Value', accessorFn: row => metricValue(row) },
  { accessorKey: 'source', header: 'Source' },
  { accessorKey: 'window', header: 'Measurement window' },
  { accessorKey: 'observedAt', header: 'Observed', cell: ({ row }) => row.original.observedAt ? <DateLabel value={row.original.observedAt} /> : 'Not observed' },
];

export function OperationsDashboard({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => { const update = () => setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  const query = useQuery({ ...privateQuery, queryKey: ['operations-dashboard', userId], enabled: !signingOut && visible,
    queryFn: ({ signal }) => operationsClient.getOperationsDashboard({}, { signal, timeoutMs: 8000 }),
    refetchInterval: visible && !signingOut ? 30000 : false, refetchIntervalInBackground: false, retry: false });
  const data = query.isSuccess && !query.error && !signingOut ? query.data : undefined;
  return <section className="page-stack" aria-labelledby="operations-title">
    <div className="section-heading"><div><span className="eyebrow">INSTALLATION OPERATIONS</span><h2 id="operations-title">Services and usage</h2></div><button className="button secondary" disabled={query.isFetching || signingOut} onClick={() => void query.refetch()}><RefreshCw size={16} />Refresh observations</button></div>
    <p className="field-help">Connected services, current observations and overall metrics from this installation. Configured means connected by configuration; available requires an observation. Unknown values are not zero.</p>
    {query.error && <PanelError error={query.error} retry={() => void query.refetch()} />}
    {!data && (query.isPending || query.isFetching) && !query.error && <Loading label="Reading current operations…" />}
    {data && <>
      <p>Runtime: {runtimeLabel(data.runtimeProfile)} · Scope: {data.scope} · Observed <DateLabel value={data.generatedAt} /></p>
      <p className="field-help">Release: <code>{data.release || 'Unknown'}</code></p>
      {query.isFetching && <p className="field-help" role="status">Refreshing observations…</p>}
      <section className="browser-panel"><div className="browser-panel-heading"><h3>Connected services and status</h3></div><DataTable data={data.services} columns={serviceColumns} getRowId={row => row.id} label="service observations" /></section>
      <section className="browser-panel"><div className="browser-panel-heading"><h3>Overall metrics and usage</h3></div><DataTable data={data.metrics} columns={metricColumns} getRowId={row => row.id} label="operations metrics" /></section>
      {data.notices.length > 0 && <div className="credential-form-content"><h3>Observation coverage</h3><ul>{data.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul></div>}
    </>}
  </section>;
}
