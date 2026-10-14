import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeAPI as api } from './nativeAPI';
import { AiAdvisory, ProbabilityBar } from './AiAdvisory';
import { privateQuery, usePageVisible } from './RepositoryUI';
import { useLiveStatus } from './RepositoryLive';
import { IssueState, type PullRequest } from './gen/golf/v1/golf_pb';
import type { Config, Job } from './NativeForge';
import { policyOff, useRepositoryFeatures } from './RepositoryFeatures';

type Context = { repository: { owner: string; name: string }; repositoryId: string };
type Choice = 'inspect_changes' | 'run_tests' | 'resolve_feedback';
type Advice = { state: string; model?: string; answers?: { next: { choice: Choice; probabilities: Record<Choice, number> } } };
type AdviceReport = { job: Job; report: { capturedAt: string; advice: Advice } };
// The three options Clef chooses between, as the Worker states them to the model.
const choices: { key: Choice; label: string; sentence: string; reason: string }[] = [
  { key: 'inspect_changes', label: 'Inspect changes', sentence: 'Read the code changes next.', reason: 'No code diff was supplied to Clef, so a person should read the actual changes.' },
  { key: 'run_tests', label: 'Run tests', sentence: 'Run the tests on this exact commit next.', reason: 'Reported check states alone are not proof that the selected commits pass.' },
  { key: 'resolve_feedback', label: 'Resolve feedback', sentence: 'Resolve the current review feedback next.', reason: 'Open review feedback should be addressed before another review.' },
];
const reads = 'Clef read only metadata: title, description, review and check states. It read no code.';

export function PullAdviceCard({ context, pull, userId }: { context: Context; pull: PullRequest; userId: string }) {
  const live = useLiveStatus() === 'live', visible = usePageVisible(), client = useQueryClient();
  const [asking, setAsking] = useState<string>(), [error, setError] = useState<unknown>();
  const config = useQuery({ ...privateQuery, queryKey: ['native-config', userId], queryFn: ({ signal }) => api<Config>('/native/config', {}, signal) });
  const enabled = config.data?.evidence === true && config.data.advice === true;
  const access = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, 'access'], enabled, queryFn: ({ signal }) => api<{ role: string }>('/native/repository-access', context, signal) });
  const jobs = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, pull.number, 'jobs'], enabled,
    queryFn: ({ signal }) => api<{ jobs: Job[]; truncated: boolean }>('/native/pr-evidence/read', { ...context, action: 'list', number: pull.number }, signal), refetchInterval: visible && !live ? 5000 : false });
  // Newest first: the latest stored advice, and the latest request whatever its outcome.
  const advised = jobs.data?.jobs.find(job => job.adviceState === 'SUCCEEDED' && job.state === 'SUCCEEDED'), latest = jobs.data?.jobs.find(job => job.adviceState !== 'NONE');
  const report = useQuery({ ...privateQuery, queryKey: ['native-repository', context.repositoryId, pull.number, 'advice', advised?.id], enabled: Boolean(advised),
    queryFn: ({ signal }) => api<AdviceReport>('/native/pr-evidence/read', { ...context, action: 'report', jobId: advised!.id }, signal) });
  // A feature policy that turned advice off keeps stored advice readable and removes the request.
  const off = policyOff(useRepositoryFeatures(userId, context.repository.owner, context.repository.name, enabled).data?.features, 'advice');
  if (config.isSuccess && !enabled) return null;
  const pending = latest && ['REQUESTED', 'RESERVED'].includes(latest.adviceState) && latest.state === 'QUEUED';
  const failed = latest && latest !== advised && !pending && latest.adviceState !== 'SUCCEEDED';
  const writer = ['write', 'admin'].includes(access.data?.role || ''), open = pull.state === IssueState.OPEN && !pull.merged;
  async function ask() {
    const key = crypto.randomUUID(); setAsking(key); setError(undefined);
    try {
      await api('/native/pr-evidence', { action: 'create', idempotencyKey: key, advice: true, selection: { ...context, number: pull.number, pullRequestId: pull.id, baseCommitId: pull.base!.commitId, headCommitId: pull.head!.commitId } });
    } catch (cause) { setError(cause); } finally { setAsking(undefined); await client.invalidateQueries({ queryKey: ['native-repository', context.repositoryId, pull.number, 'jobs'] }); }
  }
  const action = writer && open && !off ? <button className="button secondary" disabled={Boolean(asking) || pending} onClick={() => void ask()}><RefreshCw size={14} aria-hidden="true"/>{pending ? 'Clef is reading…' : advised ? 'Ask Clef again' : 'Ask Clef'}</button> : null;
  const loadError = config.error || access.error || jobs.error || report.error;
  const advice = report.data?.report.advice.answers?.next, choice = choices.find(c => c.key === advice?.choice);
  return <AiAdvisory title="Clef recommendation" label="Clef recommendation" model={report.data?.report.advice.model || '@cf/cloudflare/clef'} reads={reads}
    commitId={report.data?.job.selection.headCommitId} at={report.data?.report.capturedAt} current={report.data && advised ? !advised.stale : undefined} actions={action}>
    {loadError ? <p className="error" role="alert">{loadError instanceof Error ? loadError.message : 'Clef advice could not be read.'}</p>
      : !jobs.isSuccess || advised && !report.isSuccess ? <p role="status" className="muted">Reading stored advice…</p>
      : advice && choice ? <>
        <p className="ai-advisory-lead"><span className="muted">Clef suggests</span> {choice.sentence}</p>
        <p className="ai-advisory-reason">{choice.reason}{advised?.stale ? ' The pull request changed after this advice; ask again for the current commits.' : ''}</p>
        <ProbabilityBar label="Clef's probability for each next step" chosen={advice.choice} options={choices.map(c => ({ key: c.key, label: c.label, probability: advice.probabilities[c.key] ?? 0 }))}/>
      </> : <p className="ai-advisory-empty">{pending ? 'Clef is reading this pull request’s metadata.' : 'Clef has not been asked about this pull request.'}{!pending && !writer ? ' Writers can ask for a recommendation.' : ''}</p>}
    {failed ? <p className="field-help" role="status">{latest.adviceState === 'UNKNOWN' ? 'The latest request’s outcome is unknown: no advice was stored.' : `The latest request ended ${latest.state === 'EXPIRED' ? 'expired' : 'refused'}: no advice was stored.`}{advised ? ' The advice above is from an earlier request.' : ''}</p> : null}
    {off ? <p className="field-help">{off.reason} Stored advice stays readable.</p> : null}
    {error ? <p className="error" role="alert">{error instanceof Error ? error.message : 'The request could not be confirmed.'}</p> : null}
    {action && config.data ? <p className="field-help">Asking runs one metadata-only evidence job; it counts against the {config.data.dailyLimit} daily evidence runs.</p> : null}
  </AiAdvisory>;
}
