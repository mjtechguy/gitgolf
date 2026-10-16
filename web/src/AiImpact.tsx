import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { SummaryBand } from './Layout';
import { ContributionCalendar, kindLabels, longDate, tierLabels, type AiTier, type ContributionKind, type Range } from './ContributionGraph';

// Mirrors cloudflare/forge/src/contributions.mjs impactView: installation-wide anonymous aggregates of what Golf recorded.
type Tiers = Record<AiTier, number>;
type Impact = { state: 'on'; range: Range; generatedAt: string; unreadable: string[]; excludedRepositories: number;
  heatmap: ({ day: string } & Tiers)[]; kinds: Record<ContributionKind, Tiers>;
  agentTasks: { purpose: 'change' | 'review'; tool: string; state: string; count: number; tokens: number; reported: number; costed: number; costUsd: number }[];
  proposals: { fromTasks: { opened: number; merged: number }; origins: { kind: string; opened: number; merged: number }[]; evidence: { state: string; count: number; tokens: number }[] };
  reviewAdvice: { state: string; count: number }[]; aiRuns: { kind: string; state: string; count: number; tokens: number }[];
  landing: { trigger: 'person' | 'policy'; state: string; count: number }[]; automations: { state: string; count: number; tokens: number; costed: number; costUsd: number }[];
  costs: { reportedUsd: number; reportingRuns: number; runs: number };
  comparison: { label: string; aiInvolved: { count: number; medianHours: number | null }; other: { count: number; medianHours: number | null }; truncated: boolean } } | { state: 'off' | 'unavailable'; reason: string };

const number = (value: number) => value.toLocaleString();
const tiers: AiTier[] = ['agent', 'assisted', 'declared', 'none'];
const total = (value: Tiers) => tiers.reduce((sum, tier) => sum + value[tier], 0);
const duration = (hours: number | null) => hours === null ? 'No merges' : hours < 1 ? `${Math.round(hours * 60)} min` : hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} days`;
const states = (rows: { state: string; count: number }[]) => rows.length ? rows.map(row => `${row.state.toLowerCase().replaceAll('_', ' ')} ${number(row.count)}`).join(' · ') : 'None recorded';
const sources: Record<string, string> = { contributions: 'contribution counts', 'agent-tasks': 'agent tasks', 'pull-request-origins': 'pull request origins', 'evidence-proposals': 'agent proposals',
  'review-advice': 'review advice', 'ai-runs': 'AI runs', 'land-operations': 'land operations', 'automation-runs': 'automation runs', merges: 'merges' };

type KindRow = { kind: ContributionKind } & Tiers;
const kindColumns: DataTableColumn<KindRow>[] = [
  { id: 'kind', header: 'Contribution', accessorFn: row => kindLabels[row.kind][1], cell: ({ row }) => kindLabels[row.original.kind][1].replace(/^./, letter => letter.toUpperCase()) },
  ...tiers.map((tier): DataTableColumn<KindRow> => ({ id: tier, header: tierLabels[tier][0], accessorFn: row => row[tier], sortFn: 'basic', cell: ({ row }) => number(row.original[tier]) })),
  { id: 'total', header: 'All', accessorFn: row => total(row), sortFn: 'basic', cell: ({ row }) => number(total(row.original)) },
];
type TaskRow = Extract<Impact, { state: 'on' }>['agentTasks'][number];
const taskColumns: DataTableColumn<TaskRow>[] = [
  { id: 'tool', header: 'Tool', accessorFn: row => row.tool },
  { id: 'purpose', header: 'Task', accessorFn: row => row.purpose === 'review' ? 'Review' : 'Change' },
  { id: 'state', header: 'Outcome', accessorFn: row => row.state.toLowerCase().replaceAll('_', ' ') },
  { id: 'count', header: 'Tasks', accessorFn: row => row.count, sortFn: 'basic', cell: ({ row }) => number(row.original.count) },
  { id: 'tokens', header: 'Tokens reported', accessorFn: row => row.tokens, sortFn: 'basic', cell: ({ row }) => row.original.reported ? <>{number(row.original.tokens)}<small> {number(row.original.reported)} of {number(row.original.count)} reported</small></> : 'Not reported' },
  { id: 'cost', header: 'Cost reported', accessorFn: row => row.costUsd, sortFn: 'basic', cell: ({ row }) => row.original.costed ? <>${row.original.costUsd.toFixed(2)}<small> {number(row.original.costed)} of {number(row.original.count)} reported</small></> : 'Not reported' },
];
type RunRow = Extract<Impact, { state: 'on' }>['aiRuns'][number];
const runColumns: DataTableColumn<RunRow>[] = [
  { id: 'kind', header: 'AI run', accessorFn: row => row.kind },
  { id: 'state', header: 'Outcome', accessorFn: row => row.state.toLowerCase() },
  { id: 'count', header: 'Runs', accessorFn: row => row.count, sortFn: 'basic', cell: ({ row }) => number(row.original.count) },
  { id: 'tokens', header: 'Tokens reported', accessorFn: row => row.tokens, sortFn: 'basic', cell: ({ row }) => number(row.original.tokens) },
];
type HeatRow = { day: string } & Tiers;
const heatColumns: DataTableColumn<HeatRow>[] = [
  { accessorKey: 'day', header: 'Day' },
  ...tiers.map((tier): DataTableColumn<HeatRow> => ({ id: tier, header: tierLabels[tier][0], accessorFn: row => row[tier], sortFn: 'basic', cell: ({ row }) => number(row.original[tier]) })),
];

export function AiImpact({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const [year, setYear] = useState<number | null>(null), [table, setTable] = useState(false);
  const query = useQuery({ ...privateQuery, queryKey: ['ai-impact', userId, year], enabled: !signingOut, retry: false,
    queryFn: ({ signal }) => nativeAPI<Impact>('/native/contributions/read', { action: 'impact', ...(year === null ? {} : { year }) }, signal) });
  const data = query.data;
  const cells = useMemo(() => new Map((data?.state === 'on' ? data.heatmap : []).map(day => { const ai = day.agent + day.assisted + day.declared;
    return [day.day, { value: ai, label: `${number(ai)} with AI involvement on ${longDate(day.day)} (Golf agent ${number(day.agent)}, AI-assisted ${number(day.assisted)}, declared ${number(day.declared)}); ${number(day.none)} unlabelled` }]; })), [data]);
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  if (!data) return <Loading label="Reading AI impact…" />;
  if (data.state !== 'on') return <p className="field-help" role="note">{data.reason}</p>;
  const current = new Date().getUTCFullYear(), years = Array.from({ length: 5 }, (_, i) => current - i);
  const merged = data.kinds.pull_merged, mergedAll = total(merged), mergedAi = merged.agent + merged.assisted;
  const created = data.kinds.proposal_created.agent, accepted = data.proposals.fromTasks;
  const landed = data.landing.filter(row => row.trigger === 'policy'), landedCount = landed.find(row => row.state === 'LANDED')?.count || 0;
  const period = data.range.year === null ? 'last 12 months' : String(data.range.year);
  const kindRows: KindRow[] = (Object.keys(kindLabels) as ContributionKind[]).map(kind => ({ kind, ...data.kinds[kind] }));
  return <div className="page-stack">
    <div className="settings-toolbar"><span className="field-help">Read <DateLabel value={data.generatedAt} relative /> from Golf’s own records, {data.range.from} to {data.range.to}.</span>
      <label className="ai-usage-window">Period<select value={year ?? ''} onChange={event => setYear(event.target.value ? Number(event.target.value) : null)}><option value="">Last 12 months</option>{years.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} className={query.isFetching ? 'spin' : undefined} />Refresh</button></div>
    <p className="field-help" role="note">Counts, not claims: what Golf recorded happening and what it was reported to cost. Nothing here estimates time saved or productivity. Counts are installation-wide and name no repository or person{data.excludedRepositories ? `; ${number(data.excludedRepositories)} ${data.excludedRepositories === 1 ? 'repository has' : 'repositories have'} contribution graphs turned off and ${data.excludedRepositories === 1 ? 'is' : 'are'} left out` : ''}.</p>
    {data.unreadable.length ? <p className="error" role="alert">Not readable on this schema: {data.unreadable.map(source => sources[source] || source).join(', ')}. Those sources are missing from the totals, not zero.</p> : null}
    <SummaryBand label="AI impact summary" items={[
      ['Merged pull requests with AI involvement', `${number(mergedAi)} of ${number(mergedAll)}`, mergedAll ? `${Math.round(mergedAi / mergedAll * 100)}% share: Golf agent or AI-assisted` : 'No merges recorded'],
      ['Agent proposals', number(created), 'Agent tasks with a commit and container proposals that succeeded'],
      ['Accepted', `${number(accepted.merged)} of ${number(accepted.opened)}`, 'Pull requests opened from agent tasks, merged so far'],
      ['Landed by policy', number(landedCount), 'Agentic mode landings'],
      ['Cost reported', data.costs.reportingRuns ? `$${data.costs.reportedUsd.toFixed(2)}` : 'Not reported', `${number(data.costs.reportingRuns)} of ${number(data.costs.runs)} agent tasks and automation runs reported one`],
    ]} />
    <section className="browser-panel contribution-panel" aria-labelledby="ai-impact-activity"><div className="browser-panel-heading"><h2 id="ai-impact-activity">AI activity, {period}</h2><span className="policy-card-note">Golf agent, AI-assisted and declared, by day</span></div>
      <div className="contribution-body"><ContributionCalendar range={data.range} cells={cells} label={`AI activity by day, ${period}`} unit={['contribution with AI involvement', 'contributions with AI involvement']} />
        <dl className="contribution-tiers" aria-label="Contribution tiers">{tiers.map(tier => <div key={tier}><dt>{tierLabels[tier][0]}</dt><dd>{number(kindRows.reduce((sum, row) => sum + row[tier], 0))}</dd><dd className="field-help">{tierLabels[tier][1]}</dd></div>)}</dl>
        <div className="credential-actions"><button type="button" className="button secondary" aria-expanded={table} onClick={() => setTable(value => !value)}>{table ? 'Hide the table' : 'Show as a table'}</button></div>
        {table ? <DataTable data={data.heatmap} columns={heatColumns} getRowId={row => row.day} label="AI activity by day" emptyMessage="No contributions recorded in this period." pagination={false} /> : null}</div></section>
    <section className="browser-panel" aria-labelledby="ai-impact-kinds"><div className="browser-panel-heading"><h2 id="ai-impact-kinds">Contributions by tier</h2><span className="policy-card-note">Every repository with contribution graphs on</span></div>
      <DataTable data={kindRows} columns={kindColumns} getRowId={row => row.kind} label="contributions by tier" pagination={false} /></section>
    <section className="browser-panel" aria-labelledby="ai-impact-comparison"><div className="browser-panel-heading"><h2 id="ai-impact-comparison">Comparison: time to merge</h2><span className="visibility">Comparison, not an effect</span></div>
      <SummaryBand label="Time to merge comparison" items={[
        ['Median, opened from an agent task or landed by policy', duration(data.comparison.aiInvolved.medianHours), `${number(data.comparison.aiInvolved.count)} merged`],
        ['Median, all other merged pull requests', duration(data.comparison.other.medianHours), `${number(data.comparison.other.count)} merged`],
      ]} />
      <p className="panel-footnote">{data.comparison.label} The two groups differ in size, scope and who chose to use an agent.{data.comparison.truncated ? ' Read from the first 20,000 merges in the period.' : ''}</p></section>
    <div className="settings-card-grid">
      <section className="browser-panel settings-card" aria-labelledby="ai-impact-proposals"><div className="browser-panel-heading"><h2 id="ai-impact-proposals">Agent proposals</h2></div>
        <div className="settings-card-body"><dl className="settings-profile">
          <div><dt>Pull requests from agent tasks</dt><dd>{number(accepted.opened)} opened · {number(accepted.merged)} merged</dd></div>
          {data.proposals.origins.filter(row => row.kind !== 'agent-task').map(row => <div key={row.kind}><dt>Opened {row.kind === 'api-token' ? 'through an API token' : 'by a person'}</dt><dd>{number(row.opened)} opened · {number(row.merged)} merged</dd></div>)}
          <div><dt>Container proposals</dt><dd>{states(data.proposals.evidence)}</dd></div></dl></div>
        <p className="panel-footnote">Pull requests opened before origins were recorded (schema 41) have no origin and are not listed.</p></section>
      <section className="browser-panel settings-card" aria-labelledby="ai-impact-review"><div className="browser-panel-heading"><h2 id="ai-impact-review">Review and landing</h2></div>
        <div className="settings-card-body"><dl className="settings-profile">
          <div><dt>Human reviews</dt><dd>{number(data.kinds.review.none)}</dd></div>
          <div><dt>Agent review tasks</dt><dd>{number(data.kinds.review.agent)}</dd></div>
          <div><dt>Review advice</dt><dd>{states(data.reviewAdvice)}</dd></div>
          <div><dt>Landing by policy</dt><dd>{states(landed)}</dd></div>
          <div><dt>Landing by a person</dt><dd>{states(data.landing.filter(row => row.trigger === 'person'))}</dd></div>
          <div><dt>Automation runs</dt><dd>{states(data.automations)}</dd></div></dl></div></section>
    </div>
    <section className="browser-panel" aria-labelledby="ai-impact-tasks"><div className="browser-panel-heading"><h2 id="ai-impact-tasks">Agent tasks</h2><span className="policy-card-note">Usage as each coding tool reported it</span></div>
      <DataTable data={data.agentTasks} columns={taskColumns} getRowId={row => `${row.tool}/${row.purpose}/${row.state}`} label="agent tasks" emptyMessage="No agent tasks in this period." pagination={false} /></section>
    <section className="browser-panel" aria-labelledby="ai-impact-runs"><div className="browser-panel-heading"><h2 id="ai-impact-runs">AI runs</h2><Link className="button secondary" to="/admin/ai-usage">AI usage</Link></div>
      <DataTable data={data.aiRuns} columns={runColumns} getRowId={row => `${row.kind}/${row.state}`} label="AI runs" emptyMessage="No AI runs in this period." pagination={false} />
      <p className="panel-footnote">Token counts as each model response reported them. Cloudflare billing is authoritative; see <Link to="/admin/costs">Estimated costs</Link> for what the installation’s usage costs.</p></section>
  </div>;
}
