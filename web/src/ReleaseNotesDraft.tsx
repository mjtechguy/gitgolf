import { useState } from 'react';
import { ConnectError } from '@connectrpc/connect';
import { ClipboardPaste, Sparkles } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AiAdvisory } from './AiAdvisory';
import { aiRunPending, aiRunStatus, createAiRun, listAiRuns } from './aiAPI';
import { privateQuery, usePageVisible } from './RepositoryUI';
import { policyOff, useRepositoryFeatures } from './RepositoryFeatures';
import { MarkdownBody } from './RepositoryContent';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { settingAvailable } from './runtimeCapabilities';

type Context = { repository: { owner: string; name: string }; repositoryId: string };
type Target = { tag: string; previousTag?: string };
type Output = { markdown: string; tag: string; previousTag: string | null; tagCommit: string; previousCommit: string | null; walked: number;
  pulls: number; commits: number; omittedPulls: number; omittedCommits: number; uncitedPulls: number[] };

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
const message = (error: unknown) => error instanceof ConnectError ? error.rawMessage : error instanceof Error ? error.message : 'The request could not be confirmed.';

// A Workers AI draft of release notes for the selected tag. It never publishes: "Use" fills the notes field for the person to edit.
export function ReleaseNotesDraft(props: { context: Context; userId: string; tag: string; previousChoices: readonly string[]; notes: string; busy: boolean; onUse: (markdown: string) => void }) {
  const runtime = useRuntimeCapabilities();
  if (runtime.data?.runtimeProfile !== 'cloudflare-native' || !settingAvailable(runtime.data, 'repository.ai-release-notes')) return null;
  return <Draft key={props.tag} {...props}/>;
}

function Draft({ context, userId, tag, previousChoices, notes, busy, onUse }: { context: Context; userId: string; tag: string; previousChoices: readonly string[]; notes: string; busy: boolean; onUse: (markdown: string) => void }) {
  const client = useQueryClient(), visible = usePageVisible(), [previous, setPrevious] = useState(''), [asking, setAsking] = useState(false), [error, setError] = useState<unknown>(), [used, setUsed] = useState('');
  const key = ['native-repository', context.repositoryId, 'ai', 'release-notes'];
  const off = policyOff(useRepositoryFeatures(userId, context.repository.owner, context.repository.name).data?.features, 'ai-release-notes');
  const runs = useQuery({ ...privateQuery, queryKey: key, queryFn: ({ signal }) => listAiRuns<Target, Output>(context, { kind: 'release-notes' }, signal),
    refetchInterval: query => visible && query.state.data?.runs.some(run => aiRunPending(run)) ? 2000 : false });
  const mine = runs.data?.runs.filter(run => run.target.tag === tag) || [], latest = mine[0], shown = mine.find(run => run.state === 'SUCCEEDED');
  // Only the status read compares the draft with the tags as they are now.
  const status = useQuery({ ...privateQuery, queryKey: [...key, 'status', shown?.id], enabled: Boolean(shown), queryFn: ({ signal }) => aiRunStatus<Target, Output>(context, shown!.id, signal) });
  const run = status.data?.run || shown, output = run?.output, pending = aiRunPending(latest), stale = status.data?.run.stale;
  const failed = latest && latest !== shown && !pending ? latest : undefined;
  async function ask() {
    setAsking(true); setError(undefined);
    try { await createAiRun(context, 'release-notes', previous ? { tag, previousTag: previous } : { tag }, crypto.randomUUID()); }
    catch (cause) { setError(cause); }
    finally { setAsking(false); await client.invalidateQueries({ queryKey: key }); }
  }
  const range = output ? `between ${output.previousTag ?? 'the first commit'} and ${output.tag}` : '';
  const reads = output ? `From ${plural(output.pulls, 'merged pull request')} and ${plural(output.commits, 'commit')} ${range}.` : 'Reads merged pull requests and commit subjects on the tag’s first-parent history.';
  return <AiAdvisory title="Release notes draft" label="Release notes draft" model={run?.model} reads={reads} commitId={output?.tagCommit} at={run?.updatedAt} draft current={run && status.data ? !stale : undefined}>
    {runs.error ? <p className="error" role="alert">{message(runs.error)}</p>
      : !runs.isSuccess ? <p className="muted" role="status">Reading stored drafts…</p>
      : output ? <>
        <div className="release-notes-draft-preview"><MarkdownBody text={output.markdown} label="Draft release notes, rendered Markdown"/></div>
        {stale ? <p className="ai-advisory-reason">A tag moved after this draft was written; draft again for the current range.</p> : null}
        {output.omittedPulls || output.omittedCommits ? <p className="field-help">Not read: {[output.omittedPulls ? plural(output.omittedPulls, 'older merged pull request') : '', output.omittedCommits ? plural(output.omittedCommits, 'older commit') : ''].filter(Boolean).join(' and ')} beyond the 50 pull request and 100 commit limits.</p> : null}
        {output.uncitedPulls.length ? <p className="field-help">Not mentioned in the draft: {output.uncitedPulls.map(n => '#' + n).join(', ')}.</p> : null}
      </> : <p className="ai-advisory-empty">{pending ? `Workers AI is drafting notes for ${tag}…` : `No draft for ${tag} yet.`}</p>}
    {failed ? <p className="field-help" role="status">{failed.state === 'UNKNOWN' ? 'The latest request’s outcome is unknown: no draft was stored (the answer may have failed validation).' : `The latest request was refused: ${failed.refusal || 'no reason was recorded.'}`}{shown ? ' The draft above is from an earlier request.' : ''}</p> : null}
    {off ? <p className="field-help">{off.reason} Stored drafts stay readable.</p> : null}
    {error ? <p className="error" role="alert">{message(error)}</p> : null}
    {used && used === notes ? <p className="session-notice" role="status">The draft is in the release notes field. Edit it before you publish.</p> : null}
    <div className="release-notes-draft-actions">
      {off ? null : <label>Previous tag<select aria-label="Previous tag" value={previous} disabled={asking || pending || busy} onChange={event => setPrevious(event.target.value)}>
        <option value="">Latest published release</option>{previousChoices.filter(name => name !== tag).map(name => <option key={name} value={name}>{name}</option>)}</select></label>}
      <div className="row-actions">
        {output ? <button type="button" className="button primary" disabled={busy || notes === output.markdown} onClick={() => { onUse(output.markdown); setUsed(output.markdown); }}><ClipboardPaste size={14} aria-hidden="true"/>{notes && notes !== output.markdown ? 'Replace notes with draft' : 'Use as release notes'}</button> : null}
        {off ? null : <button type="button" className="button secondary" disabled={asking || pending || busy} onClick={() => void ask()}><Sparkles size={14} aria-hidden="true"/>{pending || asking ? 'Drafting…' : output ? 'Draft again' : 'Draft notes with Workers AI'}</button>}
      </div>
    </div>
    {off ? null : <p className="field-help">Walks {tag}’s first-parent history back to the previous tag, at most 500 commits. Only Golf merges count as merged pull requests; other commits are listed by subject. Each request is one Workers AI run against this installation’s daily limit.</p>}
  </AiAdvisory>;
}
