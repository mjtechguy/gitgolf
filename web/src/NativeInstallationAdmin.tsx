import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, RefreshCw } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { SummaryBand } from './Layout';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';

// Mirrors cloudflare/forge/src/installation.mjs. Values are what the Worker holds; secret bindings are reported only as present.
export type InstallationValue = { label: string; value: string; usage?: string };
export type InstallationItem = { id: string; label: string; service: string; state: 'configured' | 'unallocated' | 'refused'; capability: string; values: InstallationValue[]; change: { settingsKey: string; alchemy: string }; reason: string };
export type InstallationOverview = { generatedAt: string; release: string; configuration: string; schema: number; workspace: string; publicOrigin: string; demoStopAt: string; groups: { id: string; label: string; items: InstallationItem[] }[] };

const states = { configured: ['Configured', 'available'], unallocated: ['Not allocated', ''], refused: ['Invalid at deploy', 'refused'] } as const;
const capabilityStates: Record<number, [string, string]> = { 1: ['Off', ''], 2: ['Not configured', ''], 3: ['Ready', 'available'], 4: ['Degraded', 'configured'] };
const short = (value: string) => /^[a-f0-9]{16,}$/.test(value) ? value.slice(0, 12) : value;

export function InstallationValues({ values }: { values: InstallationValue[] }) {
  return <dl className="settings-profile">{values.map(value => <div key={value.label}><dt>{value.label}</dt><dd>
    {value.value.includes('\n') ? <ul className="settings-value-list">{value.value.split('\n').map(line => <li key={line}><code>{line}</code></li>)}</ul> : value.value}
    {value.usage ? <small className="settings-value-usage">{value.usage}</small> : null}</dd></div>)}</dl>;
}

export function InstallationCard({ item, children }: { item: InstallationItem; children?: ReactNode }) {
  const [label, tone] = states[item.state];
  return <section className="browser-panel settings-card" aria-labelledby={`installation-${item.id}`}>
    <div className="browser-panel-heading"><h3 id={`installation-${item.id}`}>{item.label}</h3><span className={`visibility ${tone}`}>{label}</span></div>
    <div className="settings-card-body"><p className="settings-card-service">{item.service}</p><InstallationValues values={item.values} />{children}</div>
    <p className="panel-footnote">{item.reason} Changed at deploy: <code>{item.change.settingsKey}</code> in <code>forge.json</code>{item.change.alchemy ? <>, or the Alchemy script’s <code>{item.change.alchemy}</code></> : null}.</p>
  </section>;
}

export function NativeInstallationAdmin({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const query = useQuery({ ...privateQuery, queryKey: ['native-installation', userId], enabled: !signingOut, retry: false,
    queryFn: ({ signal }) => nativeAPI<InstallationOverview>('/native/installation/read', { action: 'read' }, signal) });
  const data = query.isSuccess && !signingOut ? query.data : undefined;
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  if (!data) return <Loading label="Reading installation settings…" />;
  const items = data.groups.flatMap(group => group.items), configured = items.filter(item => item.state === 'configured').length, refused = items.filter(item => item.state === 'refused').length;
  return <>
    <div className="settings-toolbar"><span className="field-help">Read <DateLabel value={data.generatedAt} relative /> from the Worker’s current bindings.</span>
      <button className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} />Refresh</button>
      <Link className="button secondary" to="/admin/operations"><Activity size={15} />Open Operations</Link></div>
    <SummaryBand label="Installation summary" items={[
      ['Workspace', data.workspace, data.publicOrigin.replace(/^https:\/\//, '')],
      ['Release', <code key="release">{short(data.release)}</code>, `Configuration ${short(data.configuration)}`],
      ['Schema', String(data.schema), 'Applied D1 migrations'],
      ['Services', `${configured} of ${items.length}`, refused ? `${refused} invalid at deploy` : 'Configured'],
      ['Validation window', data.demoStopAt ? <DateLabel key="stop" value={data.demoStopAt} /> : 'No end set', data.demoStopAt ? 'Background work stops after this date' : undefined],
    ]} />
    {data.groups.map(group => <section key={group.id} className="settings-group" aria-labelledby={`installation-group-${group.id}`}>
      <h2 id={`installation-group-${group.id}`}>{group.label}</h2>
      <div className="settings-card-grid">{group.items.map(item => <InstallationCard key={item.id} item={item} />)}</div>
    </section>)}
    <InstallationCapabilities />
  </>;
}

type Capability = { id: string; label: string; state: number; reason: string };
const capabilityColumns: DataTableColumn<Capability>[] = [
  { id: 'capability', header: 'Capability', accessorFn: row => `${row.label} ${row.id}`, cell: ({ row }) => <><strong>{row.original.label || row.original.id}</strong><small>{row.original.id}</small></> },
  { id: 'state', header: 'State', accessorFn: row => capabilityStates[row.state]?.[0] || 'Unreported', cell: ({ row }) => { const [label, tone] = capabilityStates[row.original.state] || ['Unreported', '']; return <span className={`visibility ${tone}`}>{label}</span>; } },
  { accessorKey: 'reason', header: 'What applies' },
];
function InstallationCapabilities() {
  const runtime = useRuntimeCapabilities(), [open, setOpen] = useState(false);
  const rows = (runtime.data?.capabilities || []).map(c => ({ id: c.id, label: c.label, state: c.state, reason: c.reason }));
  return <details className="settings-diagnostics" onToggle={event => setOpen(event.currentTarget.open)}><summary>Capabilities this installation reports{rows.length ? ` (${rows.length})` : ''}</summary>
    {open ? runtime.error ? <PanelError error={runtime.error} retry={() => void runtime.refetch()} /> : <section className="browser-panel">
      <DataTable data={rows} columns={capabilityColumns} getRowId={row => row.id} label="Installation capabilities" /></section> : null}
  </details>;
}
