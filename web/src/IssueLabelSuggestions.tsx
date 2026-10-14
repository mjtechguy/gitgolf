import { useState } from 'react';
import { ConnectError } from '@connectrpc/connect';
import { Sparkles, Tags } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AiAdvisory } from './AiAdvisory';
import { aiRunPending, createAiRun, listAiRuns, aiRunStatus, type AiRun } from './aiAPI';
import { privateQuery, usePageVisible } from './RepositoryUI';
import { policyOff, useRepositoryFeatures } from './RepositoryFeatures';
import type { DiscussionLabel } from './gen/golf/v1/golf_pb';

type Context = { repository: { owner: string; name: string }; repositoryId: string };
type Target = { number: number };
type Suggestion = { labelId: string; name: string; color: string; probability: number };
type Output = { choice: string; none: number; considered: number; suggestions: Suggestion[]; ranked: Suggestion[]; issueNumber: number; truncated: boolean };
type Run = AiRun<Target, Output>;

const color = (value: string) => /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : 'currentColor';
const percent = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100);
const message = (error: unknown) => error instanceof ConnectError ? error.rawMessage : error instanceof Error ? error.message : 'The request could not be confirmed.';

// One row per label: its chip, a meter and the percentage; the same layout as the shared probability bar.
function LabelOdds({ label, rows, chosen }: { label: string; rows: { key: string; name: string; color?: string; probability: number }[]; chosen?: string }) {
  return <ul className="probability-bar label-odds" aria-label={label}>{rows.map(row => <li key={row.key} className={row.key === chosen ? 'chosen' : undefined}>
    <span className="probability-label">{row.color ? <span className="discussion-label-chip"><svg className="discussion-label-swatch" viewBox="0 0 10 10" width={10} height={10} aria-hidden="true"><circle cx={5} cy={5} r={4} fill={color(row.color)}/></svg><span>{row.name}</span></span> : <span className="muted">{row.name}</span>}</span>
    <meter min={0} max={1} value={row.probability} aria-label={`${row.name}: ${percent(row.probability)}%`}/>
    <span className="probability-value">{percent(row.probability)}%</span>
  </li>)}</ul>;
}

// Clef's label suggestions for one issue, on request, for label editors. Applying opens the existing labels editor with the suggestions selected.
export function IssueLabelSuggestions({ context, userId, number, labelChoices, busy, onApply }: {
  context: Context; userId: string; number: number; labelChoices: readonly DiscussionLabel[]; busy: boolean; onApply: (labelIds: string[]) => void;
}) {
  const client = useQueryClient(), visible = usePageVisible(), [asking, setAsking] = useState(false), [error, setError] = useState<unknown>();
  const key = ['native-repository', context.repositoryId, 'ai', 'triage', number];
  const off = policyOff(useRepositoryFeatures(userId, context.repository.owner, context.repository.name).data?.features, 'ai-triage');
  const runs = useQuery({ ...privateQuery, queryKey: key, queryFn: ({ signal }) => listAiRuns<Target, Output>(context, { kind: 'triage', target: { number } }, signal),
    refetchInterval: query => visible && query.state.data?.runs.some(run => aiRunPending(run)) ? 2000 : false });
  const latest = runs.data?.runs[0], shown = runs.data?.runs.find(run => run.state === 'SUCCEEDED');
  // The list makes no current-or-stale claim; the run's status compares it with the issue and labels now.
  const status = useQuery({ ...privateQuery, queryKey: [...key, 'status', shown?.id], enabled: Boolean(shown), queryFn: ({ signal }) => aiRunStatus<Target, Output>(context, shown!.id, signal) });
  const run: Run | undefined = status.data?.run || shown, output = run?.output, pending = aiRunPending(latest);
  async function ask() {
    setAsking(true); setError(undefined);
    try { await createAiRun(context, 'triage', { number }, crypto.randomUUID()); }
    catch (cause) { setError(cause); }
    finally { setAsking(false); await client.invalidateQueries({ queryKey: key }); }
  }
  const available = new Set(labelChoices.map(label => label.id));
  const applicable = output?.suggestions.filter(suggestion => available.has(suggestion.labelId)) || [];
  const top = output?.suggestions[0], considered = output?.considered ?? 0;
  const failed = latest && latest !== shown && !pending ? latest : undefined;
  return <AiAdvisory title="Label suggestions" label="Clef label suggestions" model={run?.model || '@cf/cloudflare/clef'} at={run?.updatedAt}
    reads={`Clef read the title and description only${output?.truncated ? ' (the description’s first 4 KiB)' : ''}.`} current={run && status.data ? !status.data.run.stale : undefined}>
    {runs.error ? <p className="error" role="alert">{message(runs.error)}</p>
      : !runs.isSuccess ? <p className="muted" role="status">Reading stored suggestions…</p>
      : output ? <>
        <p className="ai-advisory-lead">{output.choice === 'none' || !top ? <><span className="muted">Clef found</span> no label that fits well</> : <><span className="muted">Clef suggests</span> {output.suggestions.map(s => s.name).join(', ')}</>}</p>
        {output.suggestions.length ? <LabelOdds label="Clef's probability for each suggested label" chosen={output.choice} rows={output.suggestions.map(s => ({ key: s.labelId, name: s.name, color: s.color, probability: s.probability }))}/>
          : <p className="ai-advisory-reason">No label reached 15%{output.choice === 'none' ? `; Clef put ${percent(output.none)}% on none of the ${considered} labels fitting` : ''}.</p>}
        {status.data?.run.stale ? <p className="ai-advisory-reason">The issue or the repository’s labels changed after Clef read them; ask again for a current suggestion.</p> : null}
        <details className="metadata-details"><summary>All {considered} labels Clef weighed</summary>
          <LabelOdds label="Clef's probability for every label and for none" chosen={output.choice} rows={[...output.ranked.map(s => ({ key: s.labelId, name: s.name, color: s.color, probability: s.probability })), { key: 'none', name: 'None of these', probability: output.none }]}/>
        </details>
      </> : <p className="ai-advisory-empty">{pending ? 'Clef is reading the title and description…' : 'Clef has not been asked about this issue.'}</p>}
    {failed ? <p className="field-help" role="status">{failed.state === 'UNKNOWN' ? 'The latest request’s outcome is unknown: no suggestion was stored.' : `The latest request was refused: ${failed.refusal || 'no reason was recorded.'}`}{shown ? ' The suggestion above is from an earlier request.' : ''}</p> : null}
    {off ? <p className="field-help">{off.reason} Stored suggestions stay readable.</p> : null}
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    <div className="row-actions">
      {applicable.length ? <button className="button primary" disabled={busy} onClick={() => onApply(applicable.map(s => s.labelId))}><Tags size={14} aria-hidden="true"/>Review and apply</button> : null}
      {off ? null : <button className="button secondary" disabled={asking || pending || busy} onClick={() => void ask()}><Sparkles size={14} aria-hidden="true"/>{pending || asking ? 'Clef is reading…' : output ? 'Ask again' : 'Suggest labels'}</button>}
    </div>
    {off ? null : <p className="field-help">Clef chooses among at most 20 labels. Each request is one Workers AI run against this installation’s daily limit; labels change only when you save them.</p>}
  </AiAdvisory>;
}
