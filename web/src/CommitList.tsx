import { memo } from 'react';
import { Link } from '@tanstack/react-router';
import { Code2, GitCommitHorizontal, MoreHorizontal } from 'lucide-react';
import type { Commit } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import { CopyButton, DateLabel, disclosureDismiss, shortSHA } from './RepositoryUI';

// Keep native history order, including nonchronological author dates. Only
// consecutive local-calendar dates group; pagination can extend the last group.
function commitDateGroups(commits: Commit[]) {
  const groups: { day: string; commits: Commit[] }[] = [];
  for (const commit of commits) {
    const date = new Date(commit.authoredAt);
    const day = Number.isNaN(date.getTime()) ? 'unknown' : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (groups.at(-1)?.day === day) groups.at(-1)!.commits.push(commit);
    else groups.push({ day, commits: [commit] });
  }
  return groups;
}

// History accumulates 20 commits per page; each page renders only its new rows.
const CommitRow = memo(function CommitRow({ commit, location }: { commit: Commit; location: RepositoryLocation }) {
  return <li><div className="commit-row-content"><div className="commit-row-title"><h4><Link {...repositoryOptions(location, { view: 'commits', commit: commit.sha })}>{commit.message.split('\n')[0] || 'Untitled commit'}</Link></h4>{commit.message.split('\n').slice(1).some(line => line.trim()) ? <details className="commit-message" onKeyDown={disclosureDismiss.onKeyDown}><summary role="button" aria-label={`Full commit message ${shortSHA(commit.sha)}`} title="Full commit message"><MoreHorizontal size={16} aria-hidden="true"/></summary><pre>{commit.message}</pre></details> : null}</div><p>{commit.authorName || 'Unknown author'} · <DateLabel value={commit.authoredAt}/></p></div><div className="commit-row-actions"><Link className="sha-link" {...repositoryOptions(location, { view: 'commits', commit: commit.sha })} aria-label={`View diff ${shortSHA(commit.sha)}`} title={commit.sha}>{shortSHA(commit.sha)}</Link><CopyButton text={commit.sha} label={`Copy full SHA ${shortSHA(commit.sha)}`}/><Link className="icon-button" {...repositoryOptions(location, { view: 'source', ref: commit.sha, branch: '', path: '' })} aria-label={`Browse commit ${shortSHA(commit.sha)}`} title="Browse repository at this commit"><Code2 size={16} aria-hidden="true"/></Link></div></li>;
});

export function CommitList({commits,location}:{commits:Commit[];location:RepositoryLocation}) {
  return <div className="commit-groups">{commitDateGroups(commits).map((group) => <section className="commit-date-group" key={group.commits[0]!.sha} aria-labelledby={`commit-day-${group.commits[0]!.sha}`}><h3 id={`commit-day-${group.commits[0]!.sha}`}><GitCommitHorizontal size={16} aria-hidden="true"/>{group.day === 'unknown' ? 'Author date unavailable' : <>Authored on <DateLabel value={group.commits[0]!.authoredAt}/></>}</h3><ol className="commit-list">{group.commits.map((commit) => <CommitRow key={commit.sha} commit={commit} location={location}/>)}</ol></section>)}</div>;
}
