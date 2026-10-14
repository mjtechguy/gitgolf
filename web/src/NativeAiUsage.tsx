import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Cpu, RefreshCw } from 'lucide-react';
import { nativeAPI } from './nativeAPI';
import { DataTable, type DataTableColumn } from './DataTable';
import { DateLabel, Loading, PanelError, privateQuery } from './RepositoryUI';
import { SummaryBand } from './Layout';
import { ModelChip, shortModel } from './AiModelSettings';

// Mirrors cloudflare/forge/src/ai-usage.mjs. Token counts are what each model response reported; Cloudflare billing is authoritative.
type LedgerRow = { day: string; feature: string; source: 'runs' | 'advice' | 'agents'; model: string; runs: number; succeeded: number; failed: number; refused: number; pending: number;
  inputTokens: number; outputTokens: number; tokens: number; reported: number };
type Gateway = { state: 'observed' | 'degraded' | 'unavailable'; reason: string; gateway: string; window: { start: string; end: string }; requests?: number; errors?: number; cost?: number;
  tokensIn?: number; tokensOut?: number; models?: { model: string; requests: number; cost: number; errors: number }[] };
export type AiUsage = { generatedAt: string; days: number; since: string; today: string; allocated: boolean; limit: { daily: number; todayRuns: number | null; source: 'deploy' | 'default' };
  rows: LedgerRow[]; unreadable: string[]; caps: { requestsPerMinute: number; spendCentsPerDay: number } | null; gateway: Gateway };

const features: Record<string, string> = { agents: 'Agent proposals', advice: 'Review advice', 'review-draft': 'Review drafts', 'review-drafts': 'Review drafts', triage: 'Issue triage',
  'release-notes': 'Release notes', 'intent-summary': 'Intent summaries', index: 'Search indexing', search: 'Semantic search' };
const featureName = (id: string) => features[id] || id;
const number = (value: number) => value.toLocaleString();
const gatewayStates = { observed: ['Observed', 'available'], degraded: ['Degraded', 'configured'], unavailable: ['Not connected', ''] } as const;

type ModelRow = { model: string; features: string; runs: number; succeeded: number; failed: number; refused: number; inputTokens: number; outputTokens: number; tokens: number; reported: number };
const modelColumns: DataTableColumn<ModelRow>[] = [
  { id: 'model', header: 'Model', accessorFn: row => row.model, cell: ({ row }) => <ModelChip model={row.original.model} /> },
  { accessorKey: 'features', header: 'Features' },
  { id: 'runs', header: 'Runs', accessorFn: row => row.runs, sortFn: 'basic', cell: ({ row }) => number(row.original.runs) },
  { id: 'outcome', header: 'Succeeded · unknown · refused', accessorFn: row => row.failed, sortFn: 'basic', cell: ({ row }) => `${number(row.original.succeeded)} · ${number(row.original.failed)} · ${number(row.original.refused)}` },
  { id: 'input', header: 'Input tokens', accessorFn: row => row.inputTokens, sortFn: 'basic', cell: ({ row }) => row.original.inputTokens ? number(row.original.inputTokens) : '—' },
  { id: 'output', header: 'Output tokens', accessorFn: row => row.outputTokens, sortFn: 'basic', cell: ({ row }) => row.original.outputTokens ? number(row.original.outputTokens) : '—' },
  { id: 'tokens', header: 'Total tokens', accessorFn: row => row.tokens, sortFn: 'basic', cell: ({ row }) => <>{number(row.original.tokens)}{row.original.reported < row.original.runs - row.original.refused ? <small>{number(row.original.reported)} of {number(row.original.runs - row.original.refused)} reported</small> : null}</> },
];

function sum<T>(rows: T[], pick: (row: T) => number) { return rows.reduce((total, row) => total + pick(row), 0); }

export function NativeAiUsage({ userId, signingOut }: { userId: string; signingOut: boolean }) {
  const [days, setDays] = useState(14);
  const query = useQuery({ ...privateQuery, queryKey: ['ai-usage', userId, days], enabled: !signingOut, retry: false,
    queryFn: ({ signal }) => nativeAPI<AiUsage>('/native/ai-usage/read', { action: 'read', days }, signal) });
  if (query.error) return <PanelError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  if (!data) return <Loading label="Reading AI usage…" />;
  const rows = data.rows, ledger = rows.filter(row => row.source === 'runs');
  const dates = Array.from({ length: data.days }, (_, i) => new Date(Date.parse(data.today + 'T00:00:00Z') - (data.days - 1 - i) * 86400_000).toISOString().slice(0, 10)).reverse();
  const perDay = new Map(dates.map(date => [date, sum(ledger.filter(row => row.day === date), row => row.runs)]));
  const byFeature = [...rows.reduce((map, row) => { const seen = map.get(row.feature) || { feature: row.feature, runs: 0, failed: 0, tokens: 0 }; map.set(row.feature, { ...seen, runs: seen.runs + row.runs, failed: seen.failed + row.failed, tokens: seen.tokens + row.tokens }); return map; }, new Map<string, { feature: string; runs: number; failed: number; tokens: number }>()).values()].sort((a, b) => b.tokens - a.tokens || b.runs - a.runs);
  const byModel = [...rows.reduce((map, row) => { const seen = map.get(row.model); map.set(row.model, seen ? { ...seen, features: seen.features.includes(featureName(row.feature)) ? seen.features : `${seen.features}, ${featureName(row.feature)}`,
    runs: seen.runs + row.runs, succeeded: seen.succeeded + row.succeeded, failed: seen.failed + row.failed, refused: seen.refused + row.refused, inputTokens: seen.inputTokens + row.inputTokens, outputTokens: seen.outputTokens + row.outputTokens, tokens: seen.tokens + row.tokens, reported: seen.reported + row.reported }
    : { model: row.model, features: featureName(row.feature), runs: row.runs, succeeded: row.succeeded, failed: row.failed, refused: row.refused, inputTokens: row.inputTokens, outputTokens: row.outputTokens, tokens: row.tokens, reported: row.reported }); return map; }, new Map<string, ModelRow>()).values()];
  const peak = Math.max(1, ...byFeature.map(item => item.tokens)), gateway = data.gateway, [gatewayLabel, gatewayTone] = gatewayStates[gateway.state];
  return <div className="page-stack">
    <div className="settings-toolbar"><span className="field-help">Read <DateLabel value={data.generatedAt} relative /> from Golf’s run records{gateway.state === 'observed' ? ' and AI Gateway analytics' : ''}.</span>
      <label className="ai-usage-window">Window<select value={days} onChange={event => setDays(Number(event.target.value))}>{[7, 14, 30].map(value => <option key={value} value={value}>Last {value} days</option>)}</select></label>
      <button type="button" className="button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} className={query.isFetching ? 'spin' : undefined} />Refresh</button>
      <Link className="button secondary" to="/admin/ai"><Cpu size={15} />AI models</Link></div>
    <SummaryBand label="AI usage summary" items={[
      ['AI runs today', data.limit.todayRuns === null ? 'Unknown' : `${number(data.limit.todayRuns)} of ${number(data.limit.daily)}`, `Daily limit ${data.limit.source === 'deploy' ? 'as deployed' : '(default)'}`],
      [`Runs, ${data.days} days`, number(sum(rows, row => row.runs)), `${number(sum(rows, row => row.succeeded))} succeeded`],
      ['Tokens reported', number(sum(rows, row => row.tokens)), 'As each model response reported'],
      ['Unknown outcomes', number(sum(rows, row => row.failed)), 'Inference started; no stored answer'],
      ['AI Gateway', gatewayLabel, gateway.state === 'observed' ? `${number(gateway.requests || 0)} requests in 24 h` : 'See the gateway panel'],
    ]} />
    {!data.allocated ? <p className="field-help" role="note">Workers AI is not allocated now; earlier runs are still listed.</p> : null}
    {data.unreadable.length ? <p className="error" role="alert">Not readable on this schema: {data.unreadable.join(', ')}. Those sources are missing from the totals, not zero.</p> : null}
    <div className="settings-card-grid ai-usage-grid">
      <section className="browser-panel settings-card" aria-labelledby="ai-usage-daily"><div className="browser-panel-heading"><h2 id="ai-usage-daily">AI runs by day</h2><span className="policy-card-note">Against the daily limit of {number(data.limit.daily)}</span></div>
        <ul className="ai-usage-bars" aria-label="AI runs by day">{dates.map(date => { const value = perDay.get(date) || 0; return <li key={date} title={`${date}: ${value} of ${data.limit.daily}`}>
          <span className="ai-usage-bar-label">{date === data.today ? 'Today' : date.slice(5)}</span><meter min={0} max={data.limit.daily} value={value} aria-label={`${date}: ${value} runs of ${data.limit.daily}`} /><span className="ai-usage-bar-value">{number(value)}</span></li>; })}</ul>
        <p className="panel-footnote">Runs through the AI workflow count against this limit. Review advice and agent proposals count against the evidence limit instead and are included in the other totals.</p></section>
      <section className="browser-panel settings-card" aria-labelledby="ai-usage-features"><div className="browser-panel-heading"><h2 id="ai-usage-features">Tokens by feature</h2><span className="policy-card-note">Last {data.days} days</span></div>
        {byFeature.length ? <ul className="ai-usage-bars ai-usage-feature-bars" aria-label="Tokens by feature">{byFeature.map(item => <li key={item.feature} title={`${featureName(item.feature)}: ${item.tokens} tokens over ${item.runs} runs`}>
          <span className="ai-usage-bar-label">{featureName(item.feature)}<small>{number(item.runs)} runs{item.failed ? ` · ${number(item.failed)} unknown` : ''}</small></span><meter min={0} max={peak} value={item.tokens} aria-label={`${featureName(item.feature)}: ${item.tokens} tokens`} /><span className="ai-usage-bar-value">{number(item.tokens)}</span></li>)}</ul>
          : <p className="panel-footnote">No AI runs in this window.</p>}
        <p className="panel-footnote">Token counts as reported by each model response; Cloudflare billing is authoritative.</p></section>
      <section className="browser-panel settings-card" aria-labelledby="ai-usage-gateway"><div className="browser-panel-heading"><h2 id="ai-usage-gateway">AI Gateway{gateway.gateway ? <code>{gateway.gateway}</code> : null}</h2><span className={`visibility ${gatewayTone}`}>{gatewayLabel}</span></div>
        <div className="settings-card-body">
          {gateway.state === 'observed' ? <><dl className="settings-profile">
            <div><dt>Requests</dt><dd>{number(gateway.requests || 0)}{gateway.errors ? <small className="settings-value-usage">{number(gateway.errors)} errored</small> : null}</dd></div>
            <div><dt>Tokens</dt><dd>{number(gateway.tokensIn || 0)} in · {number(gateway.tokensOut || 0)} out</dd></div>
            <div><dt>Cost estimate</dt><dd>${(gateway.cost || 0).toFixed(4)}<small className="settings-value-usage">AI Gateway’s cost estimate, last 24 h{data.caps ? `, against a ${data.caps.spendCentsPerDay}-cent limit` : ''}. The gateway enforces its own window; remaining allowance is not observed.</small></dd></div></dl>
            {gateway.models?.length ? <ul className="ai-chip-row ai-gateway-models">{gateway.models.map(item => <li key={item.model}><ModelChip model={item.model} /> {number(item.requests)} requests</li>)}</ul> : null}</>
            : <p className={gateway.state === 'degraded' ? 'error' : 'policy-row-detail'} role={gateway.state === 'degraded' ? 'alert' : undefined}>Gateway analytics unavailable: {gateway.reason}</p>}
          <dl className="settings-profile">
            <div><dt>Limits as deployed</dt><dd>{data.caps ? `${data.caps.requestsPerMinute} requests a minute · ${data.caps.spendCentsPerDay} cents a day` : 'Not reported by this deploy'}</dd></div>
            <div><dt>Window</dt><dd><DateLabel value={gateway.window.start} /> to <DateLabel value={gateway.window.end} /></dd></div></dl>
        </div></section>
    </div>
    <section className="browser-panel" aria-labelledby="ai-usage-models"><div className="browser-panel-heading"><h2 id="ai-usage-models">By model</h2><span className="policy-card-note">Since {data.since}</span></div>
      <DataTable data={byModel} columns={modelColumns} getRowId={row => row.model} label="AI usage by model" emptyMessage="No AI runs in this window." pagination={false} /></section>
    <p className="panel-footnote">Golf counts every run it admitted, including ones refused before inference (never billed) and ones whose outcome is unknown (possibly billed). Agent proposals report one token total per proposal. {byModel.length ? `Models seen: ${byModel.map(row => shortModel(row.model)).join(', ')}.` : ''}</p>
  </div>;
}
