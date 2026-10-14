import { useState, type ReactNode } from 'react';
import { Copy, FilePlus2, LoaderCircle, Sparkles } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeAPI } from './nativeAPI';
import { AiAdvisory } from './AiAdvisory';
import { aiRunPending, aiRunStatus, createAiRun, listAiRuns, type AiRun } from './aiAPI';
import { MarkdownBody } from './RepositoryContent';
import { privateQuery, usePageVisible } from './RepositoryUI';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { settingAvailable } from './runtimeCapabilities';
import { policyOff, useRepositoryFeatures } from './RepositoryFeatures';
import { IssueState, type PullRequest } from './gen/golf/v1/golf_pb';

// The Worker's 'review-draft' kind: a summary and review notes on new-side lines of the exact diff, visible only to the requester.
export const reviewDraftKind = 'review-draft';
type Context = { repository: { owner: string; name: string }; repositoryId: string };
type Target = { number: number; pullRequestId: string; baseCommitId: string; headCommitId: string };
type Severity = 'high' | 'medium' | 'low';
// title, evidence and suggestion are plain text (rendered as text); summary and markdown are neutralized Markdown.
export type ReviewFinding = { path: string; line: number; severity: Severity; title: string; evidence: string; suggestion: string };
export type ReviewDraft = { summary: string; findings: ReviewFinding[]; markdown: string;
  read: { files: number; of: number; bytes: number; notRead: { path: string; reason: 'binary' | 'size' }[]; notReadCount: number; descriptionTruncated: boolean };
  commits: { base: string; mergeBase: string; head: string } };
type Run = AiRun<Target, ReviewDraft>;
// What the pending review panel knows about the requester's own pending review, once it has been read.
export type PendingReviewState = { loaded: boolean; ownPending: boolean };

const severities: Record<Severity, { label: string; tone: string }> = { high: { label: 'High', tone: 'refused' }, medium: { label: 'Medium', tone: 'configured' }, low: { label: 'Low', tone: '' } };
const kib = (bytes: number) => `${bytes < 10 * 1024 ? (bytes / 1024).toFixed(1) : Math.round(bytes / 1024)} KiB`;
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function reads(draft?: ReviewDraft) {
  if (!draft) return 'Workers AI reads the diff of the selected commits (whole files, up to 96 KiB), the title and the description. It reads no review comments.';
  const { read } = draft, skipped = read.notRead.map(file => `${file.path} (${file.reason === 'binary' ? 'binary' : 'over the limit'})`);
  return `Read ${read.files} of ${read.of} changed ${read.of === 1 ? 'file' : 'files'} (${kib(read.bytes)})${read.descriptionTruncated ? ', the title and the first 4 KiB of the description' : ', the title and the description'}`
    + (skipped.length ? `; not read: ${skipped.join(', ')}${read.notReadCount > skipped.length ? ` and ${read.notReadCount - skipped.length} more` : ''}` : '') + '. No review comments were read.';
}

function Findings({ findings }: { findings: ReviewFinding[] }) {
  const files = [...findings.reduce((map, finding) => map.set(finding.path, [...(map.get(finding.path) || []), finding]), new Map<string, ReviewFinding[]>())];
  return <div className="ai-findings">{files.map(([path, rows]) => <section key={path} className="ai-finding-file" aria-label={`Findings in ${path}`}>
    <h4><code>{path}</code><span className="muted">{rows.length} {rows.length === 1 ? 'finding' : 'findings'}</span></h4>
    <ol>{rows.map(finding => <li key={`${finding.line}:${finding.title}`} className="ai-finding">
      <div className="ai-finding-head"><span className={`visibility ${severities[finding.severity].tone}`}>{severities[finding.severity].label}</span><code title={`${path}:${finding.line}`}>L{finding.line}</code><strong>{finding.title}</strong></div>
      <p>{finding.evidence}</p>
      {finding.suggestion ? <p className="ai-finding-suggestion"><span>Suggestion</span>{finding.suggestion}</p> : null}
    </li>)}</ol>
  </section>)}</div>;
}

// The "Draft with Workers AI" action for the pending review panel's heading, and the requester's latest draft below it.
// onUse puts the review text into the requester's own pending review form; nothing is posted until they publish it.
export function usePullAiDraft({ context, pull, userId, enabled, review, onUse }: { context: Context; pull: PullRequest; userId: string; enabled: boolean; review: PendingReviewState; onUse: (text: string) => void }): { action: ReactNode; card: ReactNode } {
  const runtime = useRuntimeCapabilities(), client = useQueryClient(), visible = usePageVisible();
  const allowed = enabled && runtime.data?.runtimeProfile === 'cloudflare-native' && settingAvailable(runtime.isError ? undefined : runtime.data, 'pull.ai-review-drafts');
  const [asking, setAsking] = useState(false), [error, setError] = useState<unknown>(), [copied, setCopied] = useState(false);
  const access = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, 'access'], enabled: allowed, queryFn: ({ signal }) => nativeAPI<{ role: string }>('/native/repository-access', context, signal) });
  const off = policyOff(useRepositoryFeatures(userId, context.repository.owner, context.repository.name, allowed).data?.features, 'ai-review-drafts');
  const listKey = ['native-repository', context.repositoryId, pull.number, 'ai', reviewDraftKind, userId];
  // The requester's own runs only; the newest 50 of this kind in the repository, narrowed to this pull request here.
  const runs = useQuery({ ...privateQuery, queryKey: listKey, enabled: allowed, queryFn: async ({ signal }) => (await listAiRuns<Target, ReviewDraft>(context, { kind: reviewDraftKind }, signal)).runs.filter(run => run.target.number === pull.number) });
  const latest = runs.data?.[0], drafted = runs.data?.find(run => run.state === 'SUCCEEDED');
  // Status reads add the current or out-of-date comparison; the latest run is polled only while it is still running.
  const pending = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, 'ai-run', latest?.id], enabled: allowed && aiRunPending(latest),
    queryFn: ({ signal }) => aiRunStatus<Target, ReviewDraft>(context, latest!.id, signal).then(value => value.run), refetchInterval: query => visible && aiRunPending(query.state.data ?? latest) ? 2500 : false });
  const settledId = pending.data && !aiRunPending(pending.data) && pending.data.state === 'SUCCEEDED' ? pending.data.id : drafted?.id;
  const shown = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, 'ai-run', settledId, 'shown'], enabled: allowed && Boolean(settledId),
    queryFn: ({ signal }) => aiRunStatus<Target, ReviewDraft>(context, settledId!, signal).then(value => value.run) });
  if (!allowed) return { action: null, card: null };
  const current: Run | undefined = pending.data?.id === latest?.id && pending.data ? pending.data : latest;
  const writer = ['write', 'admin'].includes(access.data?.role || ''), open = pull.state === IssueState.OPEN && !pull.merged;
  const running = aiRunPending(current);
  async function ask() {
    setAsking(true); setError(undefined);
    try {
      const { run } = await createAiRun<Target, ReviewDraft>(context, reviewDraftKind, { number: pull.number, pullRequestId: pull.id, baseCommitId: pull.base!.commitId, headCommitId: pull.head!.commitId }, crypto.randomUUID());
      client.setQueryData<Run[]>(listKey, value => [run, ...(value || []).filter(row => row.id !== run.id)]);
    } catch (cause) { setError(cause); } finally { setAsking(false); }
  }
  const action = writer && open && !off ? <button type="button" className="button secondary" disabled={asking || running || runs.isPending} onClick={() => void ask()}>
    {running ? <LoaderCircle className="spin" size={14} aria-hidden="true"/> : <Sparkles size={14} aria-hidden="true"/>}{running ? 'Drafting…' : drafted || current?.state === 'SUCCEEDED' ? 'Draft again with Workers AI' : 'Draft with Workers AI'}</button> : null;
  const draft = shown.data?.state === 'SUCCEEDED' ? shown.data : undefined, output = draft?.output, stale = draft?.stale;
  const failed = current && current.id !== draft?.id && !running && current.state !== 'SUCCEEDED' ? current : undefined;
  const loadError = access.error || runs.error || pending.error || shown.error;
  // Nothing to show until there is a run, a request in flight or something to report.
  if (!current && !error && !loadError && !(off && runs.data?.length)) return { action, card: null };
  async function copy() {
    if (!output) return;
    try { await navigator.clipboard.writeText(output.markdown); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError(new Error('The browser did not allow copying; select the text instead.')); }
  }
  const use = output ? <div className="row-actions">
    <button type="button" className="button primary" disabled={stale !== false} title={stale ? 'The pull request changed after this draft.' : undefined} onClick={() => onUse(output.markdown)}><FilePlus2 size={14} aria-hidden="true"/>{review.loaded && review.ownPending ? 'Add to my pending review' : 'Start pending review with this text'}</button>
    <button type="button" className="button secondary" onClick={() => void copy()}><Copy size={14} aria-hidden="true"/>{copied ? 'Copied' : 'Copy text'}</button>
  </div> : null;
  const card = <AiAdvisory title="Review draft" label="Workers AI review draft" model={(draft || current)?.model} reads={reads(output)} commitId={output?.commits.head || current?.target.headCommitId}
    at={draft?.updatedAt || current?.updatedAt} current={draft && stale !== undefined ? !stale : undefined} draft>
    {loadError ? <p className="error" role="alert">{message(loadError, 'Review drafts could not be read.')}</p>
      : output ? <>
        <p className="ai-advisory-lead"><span className="muted">Only you can see this draft.</span> Nothing is posted until you publish it as your own review.</p>
        <MarkdownBody text={output.summary} label="Draft summary, rendered Markdown"/>
        {output.findings.length ? <Findings findings={output.findings}/> : <p className="ai-advisory-empty">No findings. No findings is not an approval: the model reads at most 96 KiB and can miss problems.</p>}
        {stale ? <p className="field-help" role="status">The pull request changed after this draft (new commits, or an edited title or description). Draft again for the current commits.</p> : null}
        {use}
        <p className="field-help">The draft goes into your pending review text, where you edit it and choose the decision yourself. Workers AI never approves or requests changes.</p>
      </> : null}
    {running ? <p className="ai-advisory-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true"/> Workers AI is reading the diff of {current!.target.headCommitId.slice(0, 12)}. This usually takes under a minute; you can leave this page.</p> : null}
    {failed ? <p className="field-help" role="status">{failed.state === 'UNKNOWN'
      ? 'The latest request’s outcome is unknown: Workers AI may have been called, but no draft was stored. Its answer may have failed validation (for example a note outside the diff), or the call did not finish.'
      : `The latest request was refused: ${failed.refusal || 'nothing was billed.'}`}{draft ? ' The draft above is from an earlier request.' : ''}</p> : null}
    {off ? <p className="field-help">{off.reason} Stored drafts stay readable.</p> : null}
    {error ? <p className="error" role="alert">{message(error, 'The request could not be confirmed.')}</p> : null}
  </AiAdvisory>;
  return { action, card };
}
