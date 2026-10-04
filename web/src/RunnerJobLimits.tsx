import { useId } from 'react';
import type { RunnerJobLimits } from './gen/golf/v1/golf_pb';

export const defaultRunnerJobLimits = { cpuMillis: 1000, memoryBytes: '268435456', pids: 64, timeoutSeconds: 900 };
export type RunnerLimitValues = typeof defaultRunnerJobLimits;
export type RunnerLimitDraft = { cpuMillis: string; memoryBytes: string; pids: string; timeoutSeconds: string };
export const validJobLimits = (v: RunnerLimitValues | undefined): v is RunnerLimitValues => Boolean(v && Number.isInteger(v.cpuMillis) && v.cpuMillis >= 100 && v.cpuMillis <= 1000 && /^[1-9][0-9]{7,8}$/.test(v.memoryBytes) && BigInt(v.memoryBytes) >= 67108864n && BigInt(v.memoryBytes) <= 268435456n && Number.isInteger(v.pids) && v.pids >= 16 && v.pids <= 64 && Number.isInteger(v.timeoutSeconds) && v.timeoutSeconds >= 1 && v.timeoutSeconds <= 900);
export const sameJobLimits = (a: RunnerLimitValues | undefined, b: RunnerLimitValues | undefined) => Boolean(a && b && a.cpuMillis === b.cpuMillis && a.memoryBytes === b.memoryBytes && a.pids === b.pids && a.timeoutSeconds === b.timeoutSeconds);
export const withinJobLimits = (child: RunnerLimitValues | undefined, parent: RunnerLimitValues | undefined) => validJobLimits(child) && validJobLimits(parent) && child.cpuMillis <= parent.cpuMillis && BigInt(child.memoryBytes) <= BigInt(parent.memoryBytes) && child.pids <= parent.pids && child.timeoutSeconds <= parent.timeoutSeconds;
export function limitsDraft(v: RunnerLimitValues): RunnerLimitDraft { return { cpuMillis: String(v.cpuMillis), memoryBytes: v.memoryBytes, pids: String(v.pids), timeoutSeconds: String(v.timeoutSeconds) }; }
export function limitsFromDraft(v: RunnerLimitDraft): RunnerLimitValues | undefined {
  if (![v.cpuMillis, v.memoryBytes, v.pids, v.timeoutSeconds].every(value => /^(?:[1-9][0-9]*)$/.test(value))) return undefined;
  const result = { cpuMillis: Number(v.cpuMillis), memoryBytes: v.memoryBytes, pids: Number(v.pids), timeoutSeconds: Number(v.timeoutSeconds) };
  return validJobLimits(result) ? result : undefined;
}
function memory(value: string) { const bytes = BigInt(value); return bytes % 1048576n === 0n ? `${bytes / 1048576n} MiB · ${value} bytes` : `${value} bytes`; }
export function RunnerLimitSummary({ requested, effective, label = 'Job resource limits' }: { requested: RunnerJobLimits; effective: RunnerJobLimits; label?: string }) {
  return <section aria-label={label}><dl className="settings-profile"><div><dt>CPU</dt><dd>Requested {requested.cpuMillis}m · effective {effective.cpuMillis}m</dd></div><div><dt>Memory per job</dt><dd>Requested {memory(requested.memoryBytes)}<br />Effective {memory(effective.memoryBytes)}</dd></div><div><dt>Process IDs per job</dt><dd>Requested {requested.pids} · effective {effective.pids}</dd></div><div><dt>Whole-attempt timeout</dt><dd>Requested {requested.timeoutSeconds}s · effective {effective.timeoutSeconds}s</dd></div></dl></section>;
}
export function RunnerJobLimitFields({ value, change, disabled = false }: { value: RunnerLimitDraft; change: (field: keyof RunnerLimitDraft, value: string) => void; disabled?: boolean }) {
  const id = useId();
  return <fieldset disabled={disabled}><legend>Requested job resource limits</legend><p className="field-help">Local Docker profile: CPU 100–1000m, memory 64–256 MiB, 16–64 process IDs and 1–900 seconds for the whole attempt. Effective values use the minimum of applicable instance, pool and repository ceilings; configured limits are not measured capacity.</p>
    <label htmlFor={id + '-cpu'}>CPU (millicores)</label><input id={id + '-cpu'} type="number" min="100" max="1000" step="1" required value={value.cpuMillis} onChange={e => change('cpuMillis', e.target.value)} />
    <label htmlFor={id + '-memory'}>Memory (bytes)</label><input id={id + '-memory'} type="text" inputMode="numeric" required value={value.memoryBytes} onChange={e => change('memoryBytes', e.target.value)} /><p className="field-help">Exact canonical bytes: 67108864–268435456. Non-MiB byte values are preserved.</p>
    <label htmlFor={id + '-pids'}>Maximum process IDs per job</label><input id={id + '-pids'} type="number" min="16" max="64" step="1" required value={value.pids} onChange={e => change('pids', e.target.value)} />
    <label htmlFor={id + '-timeout'}>Whole-attempt timeout (seconds)</label><input id={id + '-timeout'} type="number" min="1" max="900" step="1" required value={value.timeoutSeconds} onChange={e => change('timeoutSeconds', e.target.value)} />
  </fieldset>;
}
