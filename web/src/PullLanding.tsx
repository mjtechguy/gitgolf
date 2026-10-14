import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { privateQuery } from './RepositoryUI';
import { agenticKey, decisionLabels, evaluateLanding, readAgentic, riskLabels } from './agenticMode';

// Agentic mode (docs/AGENTIC_MODE.md): what the landing policy would decide for this pull request now. Read-only and shown only
// while agentic mode is on for the repository; it never lands anything.
export function PullLanding({ repository, repositoryId, userId, number, headCommitId }: { repository: { owner: string; name: string }; repositoryId: string; userId: string; number: number; headCommitId: string }) {
  const target = { repository: { owner: repository.owner, name: repository.name }, repositoryId };
  const state = useQuery({ ...privateQuery, queryKey: agenticKey(userId, repository.owner, repository.name), queryFn: ({ signal }) => readAgentic(target, signal), retry: false });
  const on = Boolean(state.data?.settings.enabled && state.data.feature.allowed);
  const landing = useQuery({ ...privateQuery, queryKey: [...agenticKey(userId, repository.owner, repository.name), 'landing', number, headCommitId], enabled: on, retry: false,
    queryFn: ({ signal }) => evaluateLanding(target, number, signal) });
  if (!on) return null;
  const value = landing.data?.evaluation;
  return <section className="metadata-details pull-landing" aria-label="Landing">
    <div className="browser-panel-heading"><h3>Landing</h3><button type="button" className="icon-button manual-refresh" aria-label="Refresh landing evaluation" title="Refresh landing evaluation" disabled={landing.isFetching} onClick={() => void landing.refetch()}><RefreshCw size={16} className={landing.isFetching ? 'spin' : ''} /></button></div>
    {landing.isError ? <p className="error" role="alert">{landing.error instanceof Error ? landing.error.message : 'The landing evaluation could not be read.'}</p>
      : !value ? <p className="field-help" role="status">Evaluating…</p> : <>
        <p><strong className={`pull-landing-decision ${value.decision}`}>{decisionLabels[value.decision]}</strong> · <span>{riskLabels[value.risk]}</span></p>
        <ul className="pull-landing-reasons">{value.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        {value.matched.sensitive.length ? <><p className="field-help">Sensitive paths</p><ul className="pull-landing-paths">{value.matched.sensitive.map(path => <li key={path}><code>{path}</code></li>)}</ul></> : null}
        <p className="field-help">{landing.data!.changedPathCount} changed {landing.data!.changedPathCount === 1 ? 'path' : 'paths'}, opened by {landing.data!.origin === 'person' ? 'a person' : landing.data!.origin === 'agent-task' ? 'an agent task' : 'an API token'}. Golf does not land pull requests on its own yet.</p>
      </>}
  </section>;
}
