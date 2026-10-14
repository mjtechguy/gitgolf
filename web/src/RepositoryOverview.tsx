import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { GitCommitHorizontal, GitPullRequest } from 'lucide-react';
import { repositoryClient } from './api';
import { IssueState } from './gen/golf/v1/golf_pb';
import type { RepositoryKey } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { DateLabel, privateQuery, shortSHA } from './RepositoryUI';

type Repository = Pick<RepositoryKey, 'owner' | 'name'>;
const firstPage = { page: 1, limit: 50 };
const more = (count: number, next: boolean) => `${count}${next ? '+' : ''}`;

// One bounded read each for open pull requests and open issues; the tabs and the overview share them.
export const openPulls = (userId: string, repository: Repository) => ({ ...privateQuery, staleTime: 60_000, queryKey: ['repository', userId, repository.owner, repository.name, 'open', 'pulls'],
  queryFn: async ({ signal }: { signal: AbortSignal }) => { const response = await repositoryClient.listPullRequests({ repository, state: IssueState.OPEN, page: firstPage }, { signal }); return { items: response.pullRequests, more: Boolean(response.page?.nextPage) }; } });
export const openIssues = (userId: string, repository: Repository) => ({ ...privateQuery, staleTime: 60_000, queryKey: ['repository', userId, repository.owner, repository.name, 'open', 'issues'],
  queryFn: async ({ signal }: { signal: AbortSignal }) => { const response = await repositoryClient.listIssues({ repository, state: IssueState.OPEN, page: firstPage }, { signal }); return { count: response.issues.length, more: Boolean(response.page?.nextPage) }; } });

// The repository at a glance: what is open and what changed last. Every figure comes from a read shown here; nothing is estimated.
export function RepositoryOverview({ location, repository, repositoryId, commitId, defaultBranch, userId }: { location: RepositoryLocation; repository: Repository; repositoryId: string; commitId: string; defaultBranch: string; userId: string }) {
  const pulls = useQuery(openPulls(userId, repository)), issues = useQuery(openIssues(userId, repository));
  const commits = useQuery({ ...privateQuery, staleTime: 60_000, queryKey: ['repository', userId, repository.owner, repository.name, 'overview-commits', repositoryId, commitId],
    queryFn: async ({ signal }) => (await repositoryClient.listCommits({ repository, repositoryId, ref: commitId, page: { page: 1, limit: 5 } }, { signal })).commits });
  const latest = commits.data?.[0];
  const figure = (ready: boolean, failed: boolean, value: string) => failed ? 'Unavailable' : ready ? value : '…';
  return <section className="repository-overview" aria-label="Repository overview">
    <dl className="summary-band">
      <div><dt>Open pull requests</dt><dd>{figure(pulls.isSuccess, pulls.isError, pulls.data ? more(pulls.data.items.length, pulls.data.more) : '')}</dd></div>
      <div><dt>Open issues</dt><dd>{figure(issues.isSuccess, issues.isError, issues.data ? more(issues.data.count, issues.data.more) : '')}</dd></div>
      <div><dt>Latest commit</dt><dd>{commits.isError ? 'Unavailable' : latest ? <DateLabel relative value={latest.authoredAt} /> : commits.isSuccess ? 'None' : '…'}</dd>{latest ? <dd className="summary-band-note"><code>{shortSHA(latest.sha)}</code> by {latest.authorName || 'an unknown author'}</dd> : null}</div>
      <div><dt>Default branch</dt><dd>{defaultBranch || 'Not set'}</dd></div>
    </dl>
    <div className="repository-overview-lists">
      <section className="browser-panel" aria-labelledby="overview-pulls"><div className="browser-panel-heading"><h2 id="overview-pulls"><GitPullRequest size={16} aria-hidden="true" />Open pull requests</h2><Link className="text-button" {...repositoryOptions(location, { view: 'pulls', pull: undefined })}>All pull requests</Link></div>
        {pulls.isError ? <p className="panel-footnote">Pull requests could not be read.</p> : !pulls.isSuccess ? <p className="panel-footnote" role="status">Reading pull requests…</p> : pulls.data.items.length ? <ul className="overview-list">{pulls.data.items.slice(0, 4).map(pull => <li key={pull.number}><Link className="overview-list-title" {...repositoryOptions(location, { view: 'pulls', pull: pull.number })}>{pull.title}</Link><span className="overview-list-meta">#{pull.number}{pull.user?.login ? ` by ${pull.user.login}` : ''}{pull.draft ? ' · Draft' : ''}</span><span className="overview-list-time"><DateLabel relative value={pull.updatedAt} /></span></li>)}</ul> : <p className="panel-footnote">No open pull requests.</p>}
      </section>
      <section className="browser-panel" aria-labelledby="overview-commits"><div className="browser-panel-heading"><h2 id="overview-commits"><GitCommitHorizontal size={16} aria-hidden="true" />Recent commits</h2><Link className="text-button" {...repositoryOptions(location, { view: 'commits', ref: commitId, commit: undefined, historyPath: undefined })}>History</Link></div>
        {commits.isError ? <p className="panel-footnote">Commits could not be read.</p> : !commits.isSuccess ? <p className="panel-footnote" role="status">Reading commits…</p> : commits.data.length ? <ul className="overview-list">{commits.data.slice(0, 4).map(commit => <li key={commit.sha}><Link className="overview-list-title" {...repositoryOptions(location, { view: 'commits', ref: commitId, refKind: undefined, refName: undefined, commit: commit.sha, historyPath: undefined })}>{commit.message.split('\n')[0] || 'Untitled commit'}</Link><span className="overview-list-meta"><code>{shortSHA(commit.sha)}</code> {commit.authorName}</span><span className="overview-list-time"><DateLabel relative value={commit.authoredAt} /></span></li>)}</ul> : <p className="panel-footnote">No commits yet.</p>}
      </section>
    </div>
  </section>;
}
