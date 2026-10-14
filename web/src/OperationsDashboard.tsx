import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { operationsClient } from './api';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { runtimeLabel } from './runtimeCapabilities';
import { metricValue } from './operationsMetrics';
import { SummaryBand } from './Layout';
import type { OperationsMetric, OperationsServiceStatus } from './gen/golf/v1/golf_pb';

const serviceStates: Record<string, [string, string]> = { available: ['Available', 'available'], observed: ['Observed', 'available'], degraded: ['Degraded', 'configured'], configured: ['Configured', ''], disabled: ['Not configured', ''], unknown: ['Unknown', ''] };
const serviceState = (state: string) => serviceStates[state] || [state, ''];
const serviceColumns: DataTableColumn<OperationsServiceStatus>[] = [
  { accessorKey: 'label', header: 'Service' },
  { id: 'state', header: 'Status', accessorFn: row => serviceState(row.state)[0], cell: ({ row }) => { const [label, tone] = serviceState(row.original.state); return <span className={`visibility ${tone}`}>{label}</span>; } },
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
// The workload band shows these when the snapshot reports them; every other metric stays in the full table.
const workload = ['repositories', 'jobs.queued', 'jobs.running', 'previews.active', 'webhooks.queued', 'email.queued', 'delivery.failed'];

export function OperationsDashboard({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const [allMetrics, setAllMetrics] = useState(false);
  useEffect(() => { const update = () => setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  const query = useQuery({ ...privateQuery, queryKey: ['operations-dashboard', userId], enabled: !signingOut && visible,
    queryFn: ({ signal }) => operationsClient.getOperationsDashboard({}, { signal, timeoutMs: 8000 }),
    refetchInterval: visible && !signingOut ? 30000 : false, refetchIntervalInBackground: false, retry: false });
  const data = query.isSuccess && !query.error && !signingOut ? query.data : undefined;
  const count = (...states: string[]) => data?.services.filter(service => states.includes(service.state)).length || 0;
  const attention = data?.services.filter(service => service.state === 'degraded') || [];
  const known = data?.metrics.filter(metric => metric.state === 'available').length || 0;
  return <>
    <div className="settings-toolbar"><span className="field-help">{data ? <>{runtimeLabel(data.runtimeProfile)} · {data.scope} · observed <DateLabel value={data.generatedAt} relative /> · release <code>{data.release || 'unknown'}</code></> : 'Reading current operations…'}</span>
      {query.isFetching && data ? <span className="field-help" role="status">Refreshing…</span> : null}
      <button className="button secondary" disabled={query.isFetching || signingOut} onClick={() => void query.refetch()}><RefreshCw size={15} />Refresh observations</button></div>
    {query.error && <PanelError error={query.error} retry={() => void query.refetch()} />}
    {!data && (query.isPending || query.isFetching) && !query.error && <Loading label="Reading current operations…" />}
    {data && <>
      <SummaryBand label="Service summary" items={[
        ['Available or observed', `${count('available', 'observed')} of ${data.services.length}`, 'Services with an observation'],
        ['Needs attention', String(attention.length), 'Degraded services'],
        ['Configured only', String(count('configured')), 'Connected, not yet observed'],
        ['Not configured', String(count('disabled')), 'No binding or policy'],
        ['Metrics with values', `${known} of ${data.metrics.length}`, 'Unknown is not zero'],
      ]} />
      {workload.some(id => data.metrics.some(metric => metric.id === id)) && <SummaryBand label="Current workload" items={workload.flatMap(id => { const metric = data.metrics.find(row => row.id === id); return metric ? [[metric.label, metric.unit === 'count' && metric.state === 'available' && metric.value !== undefined ? metric.value.toLocaleString() : metricValue(metric)] as [string, string]] : []; })} />}
      {attention.length > 0 && <section className="browser-panel" aria-labelledby="operations-attention-title"><div className="browser-panel-heading"><h2 id="operations-attention-title">Needs attention</h2></div>
        <ul className="settings-attention-list">{attention.map(service => <li key={service.id}><strong>{service.label}</strong><span>{service.detail}</span>{service.checkedAt ? <small>Last checked <DateLabel value={service.checkedAt} relative /> · {service.source}</small> : null}</li>)}</ul></section>}
      <section className="browser-panel" aria-labelledby="operations-services-title"><div className="browser-panel-heading"><h2 id="operations-services-title">Connected services</h2></div>
        <DataTable data={data.services} columns={serviceColumns} getRowId={row => row.id} label="service observations" /></section>
      <details className="settings-diagnostics" onToggle={event => setAllMetrics(event.currentTarget.open)}><summary>All metrics and usage ({data.metrics.length})</summary>
        {allMetrics ? <section className="browser-panel"><DataTable data={data.metrics} columns={metricColumns} getRowId={row => row.id} label="operations metrics" /></section> : null}</details>
      {data.notices.length > 0 && <section className="browser-panel" aria-labelledby="operations-coverage-title"><div className="browser-panel-heading"><h2 id="operations-coverage-title">Observation coverage</h2></div><ul className="settings-attention-list">{data.notices.map((notice, index) => <li key={index}><span>{notice}</span></li>)}</ul></section>}
    </>}
  </>;
}
