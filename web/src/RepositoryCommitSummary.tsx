import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryClient } from './api';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { DateLabel, privateNavigationQuery, shortSHA } from './RepositoryUI';

export function RepositoryCommitSummary({ location, repositoryId, commitId, userId }: {
  location: RepositoryLocation; repositoryId: string; commitId: string; userId: string;
}) {
  const query = useQuery({ ...privateNavigationQuery, retry: false,
    queryKey: ['repository', userId, location.owner, location.name, 'latest-commit', repositoryId, commitId],
    queryFn: async ({ signal }) => {
      const response = await repositoryClient.listCommits({ repository: { owner: location.owner, name: location.name }, repositoryId,
        ref: commitId, page: { page: 1, limit: 1 } }, { signal, timeoutMs: 8_000 });
      const commit = response.commits[0];
      if (response.repositoryId !== repositoryId || response.commitId !== commitId || response.path || response.commits.length !== 1 ||
          commit?.sha !== commitId || Number.isNaN(new Date(commit.authoredAt).getTime())) {
        throw new ConnectError('The latest commit does not match this repository snapshot.', Code.FailedPrecondition);
      }
      return commit;
    },
  });
  const commit = query.isSuccess && !query.isFetching ? query.data : undefined;
  return <div className="repository-latest-commit" aria-label="Latest commit">
    {commit ? <>
      <span className="latest-commit-author" data-initial={(commit.authorName || '?').slice(0, 2).toLowerCase()} title={commit.authorName}>{commit.authorName || 'Unknown author'}</span>
      <Link className="latest-commit-message" title={commit.message} {...repositoryOptions(location, { view: 'commits', ref:commitId, refKind:undefined,refName:undefined, commit: commit.sha, historyPath: undefined })}>{commit.message.split('\n')[0] || 'Untitled commit'}</Link>
      <Link className="latest-commit-sha" title={commit.sha} {...repositoryOptions(location, { view: 'commits', ref:commitId, refKind:undefined,refName:undefined, commit: commit.sha, historyPath: undefined })}><code>{shortSHA(commit.sha)}</code></Link>
      <DateLabel relative value={commit.authoredAt}/>
    </> : <span className="muted" role="status">{query.isError ? 'Latest commit unavailable' : 'Loading latest commit…'}</span>}
  </div>;
}
