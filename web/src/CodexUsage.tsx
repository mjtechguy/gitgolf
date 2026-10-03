import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CodexUsage as Usage, CodexQuotaWindow } from './gen/golf/v1/golf_pb';

const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function period(mins?: number) {
  if (!mins) return 'Quota window';
  if (mins % 1440 === 0) return `${mins / 1440}-day window`;
  if (mins % 60 === 0) return `${mins / 60}-hour window`;
  return `${mins}-minute window`;
}
function Window({ window, now }: { window: CodexQuotaWindow; now: number }) {
  const left = Math.max(0, 100 - window.usedPercent);
  const reset = Date.parse(window.resetsAt);
  const minutes = Math.max(0, Math.ceil((reset - now) / 60_000));
  return <div className="quota-window"><h4>{period(window.windowDurationMins)}</h4>
    <p><strong>{percent.format(left)}% remaining</strong> · {percent.format(window.usedPercent)}% used</p>
    <meter className="quota-meter" min={0} max={100} value={left} aria-label={`${period(window.windowDurationMins)} remaining`} />
    {Number.isFinite(reset) ? <p className="field-help">{reset <= now ? 'Reset due · refresh usage' : `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`} · <time dateTime={window.resetsAt}>{new Date(reset).toLocaleString()}</time></p> : <p className="field-help">Reset time not reported</p>}
  </div>;
}
export function CodexUsage({ plan, usage, pending, onRefresh }: { plan: string; usage?: Usage; pending: boolean; onRefresh: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  return <section className="panel-content page-stack" aria-label="Codex plan and usage">
    <div className="section-heading"><div><h3>Plan and usage</h3><p className="field-help">Plan: <strong>{plan ? (plan.charAt(0).toUpperCase() + plan.slice(1)).replaceAll('_', ' ') : 'Not reported'}</strong></p></div><button className="icon-button" aria-label="Refresh plan and usage" title="Refresh plan and usage" disabled={pending} onClick={onRefresh}><RefreshCw size={18} aria-hidden="true" /></button></div>
    {usage?.available ? <><div className="quota-grid">{usage.buckets.map((bucket, index) => <section key={bucket.id || index} className="quota-bucket"><h3>{bucket.name || (bucket.id === 'codex' ? 'Codex' : bucket.id) || 'Codex'}{bucket.planType && bucket.planType !== plan ? ` · ${bucket.planType.replaceAll('_', ' ')}` : ''}</h3>{bucket.primary ? <Window window={bucket.primary} now={now} /> : null}{bucket.secondary ? <Window window={bucket.secondary} now={now} /> : null}{!bucket.primary && !bucket.secondary ? <p className="field-help">Window details not reported</p> : null}</section>)}</div>
      <p>Banked resets: <strong>{usage.bankedResets === undefined ? 'Not reported' : new Intl.NumberFormat().format(usage.bankedResets)}</strong></p>
      <p className="field-help">Provider snapshot checked {new Date(usage.checkedAt).toLocaleString()}. Percentages stay as reported until refreshed; a scheduled reset does not confirm a renewed quota.</p></> : <p className="field-help">{usage?.reason || 'Refresh to load provider-reported quota windows, reset times and earned resets. Unreported values remain unknown.'}</p>}
  </section>;
}
