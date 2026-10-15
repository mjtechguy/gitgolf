import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from '@tanstack/react-form';
import { Link } from '@tanstack/react-router';
import { BarChart3, Calculator, RefreshCw } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { SummaryBand } from './Layout';

// Mirrors cloudflare/forge/src/costs.mjs. Every figure is an estimate from list prices, not a bill; what was not read is never shown as $0.
type LineState = 'observed' | 'degraded' | 'unreadable' | 'not-billed';
type Line = { rate: string; label: string; unit: string; included: number; price: number; per: number; source: string; state: LineState; reason?: string; note?: string; storage?: boolean;
  monthToDate?: number; billableMonthToDate?: number; costMonthToDate?: number; projected?: number; billableProjected?: number; costProjected?: number; scope: string; confirmed: boolean };
type Service = { id: string; label: string; source?: string; scopes?: string[]; state: 'observed' | 'partial' | 'unreadable' | 'not-configured' | 'not-billed'; reason?: string; lines: Line[];
  missing?: string[]; costMonthToDate?: number; costProjected?: number };
type Unit = { rate: string; driver: 'activity' | 'ci' | 'fixed'; label: string; unit: string; window: number | null; perWrite?: number | null; perLand?: number | null; perCiRun?: number | null; current?: number | null };
type Counts = { since: string; writes: number | null; landed: number | null; pipelines: number | null; tests: number | null; ciRuns: number | null; aiRuns: number | null; agentTasks: number | null };
export type Scenario = { agents: number; writesPerAgentPerMinute: number; activeHoursPerDay: number; prsLandedPerDay: number; ciRunsPerDay: number; basis: 'write' | 'land'; concurrentContainers: number;
  container: { vcpu: number; memoryGiB: number; diskGB: number; cpuBusy: number }; runnerHoursPerMonth: number; runnerHourlyRate: number | null };
export type Costs = { generatedAt: string; pricesAsOf: string; plan: string; period: { start: string; end: string; now: string; days: number; elapsedDays: number }; window: { start: string; end: string; days: number };
  analytics: { state: 'observed' | 'partial' | 'degraded' | 'unavailable'; reason: string }; services: Service[]; subscription: { label: string; costMonthToDate: number; costProjected: number; source: string };
  unpriced: { id: string; label: string; reason: string }[]; totals: { costMonthToDate: number; costProjected: number; missing: string[] }; counts: { month: Counts; window: Counts }; units: Unit[];
  scenario: Scenario; pricingPages: Record<string, string> };
type EstimateLine = { rate: string; service: string; label: string; unit: string; state: 'estimated' | 'not-estimated' | 'not-priced'; basis: string; reason?: string; usage?: number; included?: number; billable?: number; cost?: number };
type Estimate = { pricesAsOf: string; drivers: { writesPerMonth: number; landedPerMonth: number; ciRunsPerMonth: number; containerSecondsPerMonth: number; daysPerMonth: number }; lines: EstimateLine[];
  services: { id: string; label: string; cost: number | null; missing: string[] }[]; total: number; missing: string[]; notEstimated: string[] };

const serviceNames: Record<string, string> = { workers: 'Workers', do: 'Durable Objects', d1: 'D1', r2: 'R2', queues: 'Queues', artifacts: 'Artifacts', containers: 'Containers', ai: 'Workers AI', vectorize: 'Vectorize', runners: 'Self-hosted runners' };
const quantity = (value: number) => value >= 1e6 ? value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 }) : value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : value >= 10 ? 2 : 4 });
const money = (value: number) => value > 0 && value < 0.01 ? '< $0.01' : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const known = (value: number | null | undefined) => value === null || value === undefined ? 'Unknown' : value.toLocaleString();
const unitValue = (value: number | null | undefined) => value === null || value === undefined ? 'Not measured' : quantity(value);
const notRead: Record<LineState, string> = { observed: '', degraded: 'Not readable', unreadable: 'Not readable', 'not-billed': 'Not billed yet' };
const serviceStates: Record<Service['state'], [string, string]> = { observed: ['Read', 'available'], partial: ['Partly read', 'configured'], unreadable: ['Usage not readable', ''], 'not-configured': ['Not configured', ''], 'not-billed': ['Not billed yet', ''] };
const analyticsStates: Record<Costs['analytics']['state'], string> = { observed: 'Read', partial: 'Partly read', degraded: 'Degraded', unavailable: 'Not connected' };

const lineColumns: DataTableColumn<Line>[] = [
  { id: 'meter', header: 'Meter', accessorFn: line => line.label, cell: ({ row }) => <span className="costs-meter">{row.original.label}<small>{row.original.unit}{row.original.state === 'observed' ? row.original.note ? ` · ${row.original.note}` : '' : ` · ${row.original.reason}`}</small></span> },
  { id: 'mtd', header: 'Month to date', accessorFn: line => line.monthToDate ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.state === 'observed' ? `${quantity(row.original.monthToDate!)}${row.original.storage ? ' GB now' : ''}` : notRead[row.original.state] },
  { id: 'included', header: 'Included a month', accessorFn: line => line.included, sortFn: 'basic', cell: ({ row }) => quantity(row.original.included) },
  { id: 'billable', header: 'Billable so far', accessorFn: line => line.billableMonthToDate ?? line.billableProjected ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.state !== 'observed' ? '—' : quantity(row.original.billableMonthToDate ?? row.original.billableProjected!) },
  { id: 'cost', header: 'Estimate so far', accessorFn: line => line.costMonthToDate ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.state === 'observed' ? money(row.original.costMonthToDate!) : notRead[row.original.state] },
  { id: 'projected', header: 'Projected month', accessorFn: line => line.projected ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.state === 'observed' ? `${quantity(row.original.projected!)}${row.original.storage ? ' GB' : ''}` : '—' },
  { id: 'projectedCost', header: 'Projected estimate', accessorFn: line => line.costProjected ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.state === 'observed' ? money(row.original.costProjected!) : notRead[row.original.state] },
];
const unitColumns: DataTableColumn<Unit>[] = [
  { id: 'meter', header: 'Meter', accessorFn: unit => unit.label, cell: ({ row }) => <span className="costs-meter">{row.original.label}<small>{row.original.unit}</small></span> },
  { id: 'window', header: 'Measured in the window', accessorFn: unit => unit.window ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.window === null ? 'Not readable' : quantity(row.original.window) },
  { id: 'write', header: 'Per applied write', accessorFn: unit => unit.perWrite ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.driver === 'activity' ? unitValue(row.original.perWrite) : '—' },
  { id: 'land', header: 'Per landed pull request', accessorFn: unit => unit.perLand ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.driver === 'activity' ? unitValue(row.original.perLand) : '—' },
  { id: 'ci', header: 'Per CI run', accessorFn: unit => unit.perCiRun ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.driver === 'ci' ? unitValue(row.original.perCiRun) : row.original.driver === 'fixed' ? `Current size ${unitValue(row.original.current)} GB` : '—' },
];
const estimateColumns: DataTableColumn<EstimateLine>[] = [
  { id: 'service', header: 'Service', accessorFn: line => serviceNames[line.service] || line.service },
  { id: 'meter', header: 'Meter', accessorFn: line => line.label, cell: ({ row }) => <span className="costs-meter">{row.original.label}<small>{row.original.unit} · {row.original.basis}{row.original.reason ? ` · ${row.original.reason}` : ''}</small></span> },
  { id: 'usage', header: 'A month', accessorFn: line => line.usage ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.usage === undefined ? '—' : quantity(row.original.usage) },
  { id: 'included', header: 'Included', accessorFn: line => line.included ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.included === undefined ? '—' : quantity(row.original.included) },
  { id: 'billable', header: 'Billable', accessorFn: line => line.billable ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.billable === undefined ? '—' : quantity(row.original.billable) },
  { id: 'cost', header: 'Estimate a month', accessorFn: line => line.cost ?? -1, sortFn: 'basic', cell: ({ row }) => row.original.cost === undefined ? row.original.state === 'not-priced' ? 'Not priced' : 'Not estimated' : money(row.original.cost) },
];

function ServicePanel({ service }: { service: Service }) {
  const [label, tone] = serviceStates[service.state];
  return <section className="browser-panel" aria-labelledby={`costs-${service.id}`}>
    <div className="browser-panel-heading"><h2 id={`costs-${service.id}`}>{service.label}</h2>
      {service.costProjected !== undefined ? <span className="policy-card-note">Estimate so far {money(service.costMonthToDate!)} · projected {money(service.costProjected)}</span> : null}
      <span className={`visibility ${tone}`}>{label}</span></div>
    {service.state === 'not-configured' ? <p className="panel-footnote">{service.reason}</p> : <>
      <DataTable data={service.lines} columns={lineColumns} getRowId={line => line.rate} label={`${service.label} meters`} pagination={false} />
      <p className="panel-footnote">{service.scopes?.join(' ')}{service.missing?.length ? ` The estimate leaves out what was not read: ${service.missing.join(', ')}.` : ''} {service.source ? <a href={service.source} target="_blank" rel="noreferrer">{service.label} pricing</a> : null}</p></>}
  </section>;
}

const field = (value: number | null) => value === null ? '' : String(value);
// Measured units are shown to six significant digits; the administrator may edit any of them.
const measured = (value: number | null | undefined) => value === null || value === undefined ? '' : String(Number(value.toPrecision(6)));
const parse = (value: string) => value.trim() === '' ? null : Number(value);
const check = (min: number, max: number, optional = false) => ({ value }: { value: string }) => {
  if (value.trim() === '') return optional ? undefined : 'Enter a number.';
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? undefined : `Enter a number from ${min} to ${max}.`;
};

function ScaleUpForm({ data, onClose }: { data: Costs; onClose: () => void }) {
  const [result, setResult] = useState<Estimate>();
  const [failure, setFailure] = useState('');
  const s = data.scenario;
  const form = useForm({
    defaultValues: { agents: field(s.agents), writesPerAgentPerMinute: field(s.writesPerAgentPerMinute), activeHoursPerDay: field(s.activeHoursPerDay), prsLandedPerDay: field(s.prsLandedPerDay),
      ciRunsPerDay: field(s.ciRunsPerDay), basis: s.basis, concurrentContainers: field(s.concurrentContainers), vcpu: field(s.container.vcpu), memoryGiB: field(s.container.memoryGiB),
      diskGB: field(s.container.diskGB), cpuBusy: field(s.container.cpuBusy * 100), runnerHoursPerMonth: field(s.runnerHoursPerMonth), runnerHourlyRate: field(s.runnerHourlyRate),
      units: data.units.map(unit => ({ rate: unit.rate, perWrite: measured(unit.perWrite), perLand: measured(unit.perLand), perCiRun: measured(unit.perCiRun), current: measured(unit.current) })) },
    onSubmit: async ({ value }) => {
      setFailure('');
      const scenario: Scenario = { agents: Number(value.agents), writesPerAgentPerMinute: Number(value.writesPerAgentPerMinute), activeHoursPerDay: Number(value.activeHoursPerDay),
        prsLandedPerDay: Number(value.prsLandedPerDay), ciRunsPerDay: Number(value.ciRunsPerDay), basis: value.basis, concurrentContainers: Number(value.concurrentContainers),
        container: { vcpu: Number(value.vcpu), memoryGiB: Number(value.memoryGiB), diskGB: Number(value.diskGB), cpuBusy: Number(value.cpuBusy) / 100 },
        runnerHoursPerMonth: Number(value.runnerHoursPerMonth), runnerHourlyRate: parse(value.runnerHourlyRate) };
      const units = value.units.map(unit => ({ rate: unit.rate, perWrite: parse(unit.perWrite), perLand: parse(unit.perLand), perCiRun: parse(unit.perCiRun), current: parse(unit.current) }));
      try { setResult(await nativeAPI<Estimate>('/native/costs/read', { action: 'estimate', scenario, units })); }
      catch (error) { setResult(undefined); setFailure(error instanceof Error ? error.message : 'The estimate could not be computed.'); }
    },
  });
  const number = (name: 'agents' | 'writesPerAgentPerMinute' | 'activeHoursPerDay' | 'prsLandedPerDay' | 'ciRunsPerDay' | 'concurrentContainers' | 'vcpu' | 'memoryGiB' | 'diskGB' | 'cpuBusy' | 'runnerHoursPerMonth' | 'runnerHourlyRate',
    label: string, help: string, [min, max]: [number, number], optional = false) =>
    <form.Field name={name} validators={{ onChange: check(min, max, optional) }}>{f => <div className="costs-field"><label>{label}<input type="number" inputMode="decimal" step="any" min={min} max={max} value={f.state.value}
      onChange={event => f.handleChange(event.target.value)} placeholder={optional ? 'Not set' : undefined} /></label><small className="field-help">{help}</small>
      {f.state.meta.errors.length ? <p className="error" role="alert">{f.state.meta.errors.join(' ')}</p> : null}</div>}</form.Field>;
  const unitInput = (index: number, key: 'perWrite' | 'perLand' | 'perCiRun' | 'current', label: string) =>
    <form.Field name={`units[${index}].${key}`} validators={{ onChange: check(0, 1e12, true) }}>{f => <label className="costs-unit-input">{label}<input type="number" inputMode="decimal" step="any" min={0} value={f.state.value}
      onChange={event => f.handleChange(event.target.value)} placeholder="Not measured" />{f.state.meta.errors.length ? <span className="error" role="alert">{f.state.meta.errors.join(' ')}</span> : null}</label>}</form.Field>;
  return <section className="browser-panel" aria-labelledby="costs-scale-up">
    <div className="browser-panel-heading"><h2 id="costs-scale-up">Estimate a scale-up</h2><span className="policy-card-note">Starting values are assumptions; edit any of them</span></div>
    <form className="credential-form-content costs-form" aria-label="Estimate a scale-up" onSubmit={event => { event.preventDefault(); void form.handleSubmit(); }}>
      <fieldset className="costs-fieldset"><legend>Activity</legend><div className="costs-field-grid">
        {number('agents', 'Agents', 'Agents working at the same time.', [0, 100000])}
        {number('writesPerAgentPerMinute', 'Writes per agent per minute', 'Applied pushes and commits. About 0.5 in the 110-agent benchmark.', [0, 1000])}
        {number('activeHoursPerDay', 'Active hours per day', 'Hours a day the agents are working.', [0, 24])}
        {number('prsLandedPerDay', 'Pull requests landed per day', 'Used when activity is scaled by landed pull requests.', [0, 10000000])}
        {number('ciRunsPerDay', 'CI runs per day', 'Pipeline runs and container test runs; drive R2 and Queues.', [0, 10000000])}
      </div>
      <form.Field name="basis">{f => <div className="costs-basis" role="radiogroup" aria-label="Scale Workers, Durable Objects, D1 and Artifacts by">
        <span className="field-help">Scale Workers, Durable Objects, D1 and Artifacts by</span>
        <label className="policy-choice"><input type="radio" name="costs-basis" checked={f.state.value === 'write'} onChange={() => f.handleChange('write')} /><span><strong>Applied writes</strong><small>Unit costs per applied write, all-in.</small></span></label>
        <label className="policy-choice"><input type="radio" name="costs-basis" checked={f.state.value === 'land'} onChange={() => f.handleChange('land')} /><span><strong>Landed pull requests</strong><small>Unit costs per landed pull request, all-in.</small></span></label>
      </div>}</form.Field></fieldset>
      <fieldset className="costs-fieldset"><legend>Containers</legend><div className="costs-field-grid">
        {number('concurrentContainers', 'Concurrent containers', 'Average number running, around the clock.', [0, 10000])}
        {number('vcpu', 'vCPU each', 'Golf starts standard-1: 1/2 vCPU.', [0.0625, 4])}
        {number('memoryGiB', 'Memory each (GiB)', 'standard-1: 4 GiB.', [0.25, 12])}
        {number('diskGB', 'Disk each (GB)', 'standard-1: 8 GB.', [1, 20])}
        {number('cpuBusy', 'CPU busy (%)', 'CPU is billed on active use; 100 is the upper bound.', [0, 100])}
      </div></fieldset>
      <fieldset className="costs-fieldset"><legend>Self-hosted runners</legend><div className="costs-field-grid">
        {number('runnerHoursPerMonth', 'Runner hours per month', 'Machines you run outside Cloudflare.', [0, 1000000])}
        {number('runnerHourlyRate', 'Hourly rate (USD)', 'Your own cost per runner hour. Left empty, runners are listed as not priced.', [0, 1000], true)}
      </div></fieldset>
      <fieldset className="costs-fieldset"><legend>Unit costs</legend>
        <p className="field-help">Measured on this installation over the last {quantity(data.window.days)} days: usage read from Cloudflare divided by the counts Golf records. Each is all-in. Empty means not measured; enter your own value to include it.</p>
        <ul className="costs-units">{data.units.map((unit, index) => <li key={unit.rate}><span className="costs-meter">{unit.label}<small>{unit.unit}</small></span>
          {unit.driver === 'activity' ? <>{unitInput(index, 'perWrite', 'Per applied write')}{unitInput(index, 'perLand', 'Per landed pull request')}</>
            : unit.driver === 'ci' ? unitInput(index, 'perCiRun', 'Per CI run') : unitInput(index, 'current', 'Size in GB, not scaled')}</li>)}</ul>
      </fieldset>
      <form.Subscribe selector={state => [state.isSubmitting, state.canSubmit] as const}>{([submitting, canSubmit]) => <div className="credential-actions">
        <button className="button primary" disabled={submitting || !canSubmit}><Calculator size={15} />{submitting ? 'Estimating…' : 'Estimate'}</button>
        <button type="button" className="button secondary" disabled={submitting} onClick={onClose}>Close</button></div>}</form.Subscribe>
      {failure ? <p className="error" role="alert">{failure}</p> : null}
    </form>
    {result ? <div className="costs-result" aria-live="polite">
      <SummaryBand label="Scale-up estimate" items={[
        ['Estimate a month', money(result.total), result.missing.length ? 'Leaves out what is not estimated' : `List prices as of ${result.pricesAsOf}`],
        ['Applied writes a month', quantity(result.drivers.writesPerMonth), `${result.drivers.daysPerMonth}-day month`],
        ['Pull requests landed a month', quantity(result.drivers.landedPerMonth)],
        ['CI runs a month', quantity(result.drivers.ciRunsPerMonth)],
      ]} />
      <DataTable data={result.lines} columns={estimateColumns} getRowId={line => line.rate} label="scale-up estimate" pagination={false} />
      <p className="panel-footnote">Priced against the full monthly allowances, as if this installation were the only user of the account. Not estimated: {[...result.missing, ...result.notEstimated].join(', ')}.</p>
    </div> : null}
  </section>;
}

export function EstimatedCosts({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const [scaling, setScaling] = useState(false);
  const query = useQuery({ ...privateQuery, queryKey: ['costs', userId], enabled: !signingOut, retry: false,
    queryFn: ({ signal }) => nativeAPI<Costs>('/native/costs/read', { action: 'read' }, signal) });
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  if (!data) return <Loading label="Reading estimated costs…" />;
  const shown = data.services.filter(service => service.state !== 'not-configured'), absent = data.services.filter(service => service.state === 'not-configured');
  const month = data.counts.month, window = data.counts.window, analytics = data.analytics;
  return <div className="page-stack">
    <div className="settings-toolbar"><span className="field-help">Read <DateLabel value={data.generatedAt} relative /> · {data.plan} list prices as of {data.pricesAsOf}</span>
      <button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} className={query.isFetching ? 'spin' : undefined} />Refresh</button>
      <Link className="button secondary" to="/admin/ai-usage"><BarChart3 size={15} />AI usage</Link>
      {!scaling ? <button type="button" className="button primary" onClick={() => setScaling(true)}><Calculator size={15} />Estimate a scale-up</button> : null}</div>
    <p className="field-help costs-disclaimer" role="note">Estimates from Cloudflare list prices as of {data.pricesAsOf}; not a bill. Cloudflare’s invoice is authoritative: it rounds billable usage up to whole billing units and shares each allowance across the whole account. Pricing pages: {Object.entries(data.pricingPages).map(([id, url], index) => <span key={id}>{index ? ', ' : ''}<a href={url} target="_blank" rel="noreferrer">{serviceNames[id] || id}</a></span>)}.</p>
    <SummaryBand label="Estimated costs summary" items={[
      ['Estimate so far', money(data.totals.costMonthToDate), `Since ${data.period.start.slice(0, 10)}, ${quantity(data.period.elapsedDays)} of ${data.period.days} days`],
      ['Projected month', money(data.totals.costProjected), 'At this month’s pace so far'],
      ['Usage analytics', analyticsStates[analytics.state], analytics.state === 'observed' ? 'Cloudflare GraphQL Analytics' : 'See below'],
      ['Left out', data.totals.missing.length ? `${data.totals.missing.length} meters` : 'Nothing', data.totals.missing.length ? 'Not read, so not counted' : 'Every listed meter was read'],
    ]} />
    {analytics.state === 'unavailable' ? <p className="policy-row-detail" role="note">Usage not read: {analytics.reason}</p>
      : analytics.state !== 'observed' ? <p className="error" role="alert">Usage partly unreadable: {analytics.reason || 'see each service.'} Unread meters are left out of the totals, not counted as zero.</p> : null}
    {data.totals.missing.length ? <p className="panel-footnote">The totals leave out: {data.totals.missing.join(', ')}. They include the {data.subscription.label} ({money(data.subscription.costProjected)} a month).</p> : null}
    {scaling ? <ScaleUpForm data={data} onClose={() => setScaling(false)} /> : null}
    <h2 className="costs-section-title">Running now</h2>
    {shown.map(service => <ServicePanel key={service.id} service={service} />)}
    {absent.length ? <p className="panel-footnote">Not configured on this installation: {absent.map(service => service.label).join(', ')}.</p> : null}
    {data.unpriced.length ? <section className="browser-panel" aria-labelledby="costs-unpriced"><div className="browser-panel-heading"><h2 id="costs-unpriced">Configured, not priced here</h2><span className="policy-card-note">Not free: not read or not estimated</span></div>
      <dl className="settings-profile costs-profile">{data.unpriced.map(item => <div key={item.id}><dt>{item.label}</dt><dd>{item.reason}</dd></div>)}</dl></section> : null}
    <section className="browser-panel" aria-labelledby="costs-recorded"><div className="browser-panel-heading"><h2 id="costs-recorded">Recorded exactly by Golf</h2><span className="policy-card-note">Counts from Golf’s own records</span></div>
      <dl className="settings-profile costs-profile">
        <div><dt>AI runs this month</dt><dd>{known(month.aiRuns)} · tokens, outcomes and AI Gateway cost on <Link to="/admin/ai-usage">AI usage</Link></dd></div>
        <div><dt>Agent tasks this month</dt><dd>{known(month.agentTasks)} · usage as each tool reports it on <Link to="/admin/agents">Agent hosts</Link></dd></div>
        <div><dt>Applied writes</dt><dd>{known(month.writes)} this month · {known(window.writes)} in the last {quantity(data.window.days)} days</dd></div>
        <div><dt>Pull requests landed</dt><dd>{known(month.landed)} this month · {known(window.landed)} in the last {quantity(data.window.days)} days</dd></div>
        <div><dt>CI runs</dt><dd>{known(month.ciRuns)} this month ({known(month.pipelines)} pipeline runs, {known(month.tests)} container test runs) · {known(window.ciRuns)} in the last {quantity(data.window.days)} days</dd></div>
      </dl></section>
    <section className="browser-panel" aria-labelledby="costs-units"><div className="browser-panel-heading"><h2 id="costs-units">Unit costs measured here</h2><span className="policy-card-note">Since <DateLabel value={data.window.start} /></span></div>
      <DataTable data={data.units} columns={unitColumns} getRowId={unit => unit.rate} label="measured unit costs" pagination={false} />
      <p className="panel-footnote">Usage read from Cloudflare over the window, divided by the counts Golf recorded in the same window. Each figure is all-in: the reads, page views, landings and CI coordination that went with that activity are included, so per-write and per-landing figures are alternatives, not additions.</p></section>
  </div>;
}
