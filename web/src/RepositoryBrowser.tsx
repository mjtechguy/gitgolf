import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, BookOpen, ChevronRight, CircleDot, ExternalLink, File, Folder, GitBranch, GitCommitHorizontal, Link2, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, repositoryLink } from './api';
import type { BranchPage, CommitPage, Issue, IssuePage, RepositoryDetail, Source, SourceEntry } from './api';
import { browserHref, InternalLink, navigate } from './navigation';
import type { RepositoryLocation } from './navigation';

// Private panels revalidate on mount, do not keep inactive content, and hide data while revalidating.
const privateQuery = { staleTime: 0, gcTime: 0 };
const nextPage = (page: { next_page?: number }) => page.next_page && page.next_page > 0 ? page.next_page : undefined;
const shortSHA = (value: string) => value.slice(0, 12);
const isCommit = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

function Loading({ label }: { label: string }) {
  return <div className="browser-loading" role="status"><LoaderCircle size={20} className="spin" />{label}</div>;
}

function PanelError({ error, retry }: { error: Error; retry: () => void }) {
  return <div className="panel-error"><p className="error" role="alert">{error.message}</p><button type="button" className="button secondary" onClick={retry}><RefreshCw size={15} />Try again</button></div>;
}

function DateLabel({ value }: { value: string }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? <span>Date unavailable</span> : <time dateTime={value} title={date.toLocaleString()}>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>;
}

function Size({ value }: { value: number }) {
  return <span>{value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`}</span>;
}

function More({ hasMore, loading, load, label }: { hasMore: boolean; loading: boolean; load: () => void; label: string }) {
  return hasMore ? <button className="text-button" disabled={loading} onClick={load}>{loading ? 'Loading…' : `Load more ${label}`}<ArrowDown size={14} /></button> : null;
}

function BranchSelector({ base, queryKey, location, defaultBranch }: { base: string; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const details = useRef<HTMLDetailsElement>(null);
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'branches'], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api<BranchPage>(`${base}/branches?page=${pageParam}`, { signal }), getNextPageParam: nextPage });
  const branches = [...new Map(query.data?.pages.flatMap((page) => page.branches).map((branch) => [branch.name, branch])).values()];
  const branchName = location.branch || (!location.ref ? defaultBranch : '');
  return <div className="ref-controls">
    <details className="branch-picker" ref={details}>
      <summary><GitBranch size={16} /><span>{branchName || (isCommit(location.ref) ? 'Selected commit' : location.ref) || defaultBranch}</span><ChevronRight size={14} /></summary>
      <div className="branch-options"><strong>Choose a branch</strong><p className="field-help">Selection opens its current commit. More branches may be available below.</p>
        {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading branches…" /> : <>
          <ul>{branches.map((branch) => <li key={branch.name}><InternalLink href={browserHref(location, { ref: branch.name, branch: branch.name, path: '' })} onClick={() => { if (details.current) details.current.open = false; }}><GitBranch size={15} /><span>{branch.name}<small>Listed at {shortSHA(branch.commit_id)}</small></span>{branch.protected ? <ShieldCheck size={15} aria-label="Protected branch" /> : null}</InternalLink></li>)}</ul>
          {!branches.length ? <p className="muted">No branches available.</p> : null}
          <More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="branches" />
        </>}
      </div>
    </details>
    {location.ref && isCommit(location.ref) ? <span className="commit-pin" title={location.ref}><LockKeyhole size={12} />{shortSHA(location.ref)}</span> : <span className="field-help">Resolving a commit…</span>}
    {branchName ? <button className="text-button branch-refresh" onClick={() => navigate(browserHref(location, { ref: branchName, branch: branchName }))}><RefreshCw size={14} />Latest branch head</button> : null}
  </div>;
}

function EntryIcon({ type }: { type: SourceEntry['type'] }) {
  const Icon = type === 'dir' ? Folder : type === 'file' ? File : type === 'symlink' ? Link2 : GitCommitHorizontal;
  return <Icon size={18} aria-hidden="true" />;
}

function SourcePanel({ base, queryKey, location, defaultBranch }: { base: string; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const ref = location.ref || defaultBranch;
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'source', ref, location.path],
    queryFn: ({ signal }) => api<Source>(`${base}/contents?${new URLSearchParams({ ref, path: location.path })}`, { signal }) });
  const source = query.isSuccess && !query.isFetching ? query.data : undefined;
  useEffect(() => {
    if (source && source.commit_id !== location.ref) navigate(browserHref(location, { ref: source.commit_id, branch: location.branch || (!location.ref ? defaultBranch : isCommit(location.ref) ? '' : location.ref) }), true);
  }, [source, location, defaultBranch]);
  const selectedRef = source?.commit_id || ref;
  const crumbs = location.path.split('/').filter(Boolean);
  return <section aria-labelledby="source-title" className="browser-panel">
    <div className="browser-panel-heading"><h2 id="source-title">Source</h2><button className="icon-button" aria-label="Refresh source" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} className={query.isFetching ? 'spin' : ''} /></button></div>
    <nav className="source-breadcrumbs" aria-label="Source path"><InternalLink href={browserHref(location, { ref: selectedRef, path: '' })}>{location.name}</InternalLink>{crumbs.map((crumb, index) => <span key={index}><ChevronRight size={13} /><InternalLink href={browserHref(location, { ref: selectedRef, path: crumbs.slice(0, index + 1).join('/') })} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>{crumb}</InternalLink></span>)}</nav>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !source ? <Loading label="Reading source…" /> : source.kind === 'directory' ? <>
      {source.entries?.length ? <ul className="source-tree">{source.entries.map((entry) => <li key={entry.path}><InternalLink href={browserHref(location, { ref: source.commit_id, path: entry.path })}><EntryIcon type={entry.type} /><span className="source-name">{entry.name}</span><span className="entry-type">{entry.type === 'dir' ? 'Directory' : entry.type === 'submodule' ? 'Submodule' : entry.type === 'symlink' ? 'Symlink' : 'File'}</span>{entry.type !== 'dir' ? <Size value={entry.size} /> : <span /> }<ChevronRight size={14} /></InternalLink></li>)}</ul> : <div className="empty-state"><Folder size={25} /><h3>This directory is empty.</h3></div>}
      <p className="panel-footnote">{source.entries?.length || 0} entries · Read-only snapshot at <code>{shortSHA(source.commit_id)}</code></p>
    </> : source.file ? <>
      <div className="file-meta"><span><EntryIcon type={source.file.type} />{source.file.type}</span><Size value={source.file.size} /><span>Object <code title={source.file.sha}>{shortSHA(source.file.sha)}</code></span></div>
      {source.file.type === 'file' && source.file.content !== undefined && !source.file.preview_reason && source.file.size <= 256 * 1024 ? <pre className="source-preview" tabIndex={0} aria-label={`Plain text preview of ${source.file.name}`}><code>{source.file.content || '(Empty text file)'}</code></pre> : <div className="preview-unavailable"><File size={26} /><h3>Preview unavailable</h3><p>{source.file.preview_reason || 'This file is outside the supported plain-text preview limits.'}</p><p className="muted">Previews support UTF-8 text up to 256 KiB. Binary, large, LFS, symlink and submodule content is not opened.</p></div>}
      <p className="panel-footnote">Plain text only · Read-only snapshot at <code>{shortSHA(source.commit_id)}</code></p>
    </> : <p className="error" role="alert">The source response did not contain file metadata.</p>}
  </section>;
}

function CommitsPanel({ base, queryKey, location, defaultBranch }: { base: string; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const ref = location.ref || defaultBranch;
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'commits', ref], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api<CommitPage>(`${base}/commits?${new URLSearchParams({ ref, page: String(pageParam) })}`, { signal }), getNextPageParam: nextPage });
  const commits = query.isSuccess && (!query.isFetching || query.isFetchingNextPage) ? [...new Map(query.data.pages.flatMap((page) => page.commits).map((commit) => [commit.sha, commit])).values()] : [];
  const head = commits[0]?.sha;
  useEffect(() => {
    if (head && !isCommit(location.ref)) navigate(browserHref(location, { ref: head, branch: location.branch || location.ref || defaultBranch }), true);
  }, [head, location, defaultBranch]);
  return <section aria-labelledby="commits-title" className="browser-panel">
    <div className="browser-panel-heading"><h2 id="commits-title">Commit history</h2><button className="icon-button" aria-label="Refresh commits" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading commits…" /> : <>
      <ol className="commit-list">{commits.map((commit) => <li key={commit.sha}><GitCommitHorizontal size={20} /><div><h3>{commit.message.split('\n')[0] || 'Untitled commit'}</h3><p>{commit.author_name || 'Unknown author'} · <DateLabel value={commit.authored_at} /></p>{commit.message.includes('\n') ? <details className="commit-message"><summary>Full commit message</summary><pre>{commit.message}</pre></details> : null}</div><InternalLink className="sha-link" href={browserHref(location, { view: 'source', ref: commit.sha, branch: '', path: '' })} aria-label={`Browse commit ${shortSHA(commit.sha)}`} title={commit.sha}>{shortSHA(commit.sha)}<ChevronRight size={14} /></InternalLink></li>)}</ol>
      {!commits.length ? <div className="empty-state"><GitCommitHorizontal size={25} /><h3>No commits at this ref.</h3></div> : null}
      <div className="list-footer"><span>{commits.length} loaded commits{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="commits" /></div>
    </>}
    <p className="panel-footnote">Open a commit to browse its source snapshot. Diffs and reviews are not available yet.</p>
  </section>;
}

function IssueState({ state }: { state: string }) {
  return <span className={`issue-state ${state === 'closed' ? 'closed' : ''}`}><CircleDot size={13} />{state}</span>;
}

function IssueDetail({ base, queryKey, location }: { base: string; queryKey: readonly unknown[]; location: RepositoryLocation }) {
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'issue', location.issue], queryFn: ({ signal }) => api<{ issue: Issue }>(`${base}/issues/${location.issue}`, { signal }) });
  const issue = query.isSuccess && !query.isFetching ? query.data.issue : undefined;
  const external = issue && repositoryLink(issue.html_url);
  return <section className="browser-panel issue-detail" aria-labelledby="issue-detail-title">
    <div className="browser-panel-heading"><InternalLink className="text-button" href={browserHref(location, { issue: undefined })}><ArrowLeft size={15} />All {location.state === 'all' ? '' : location.state} issues</InternalLink><button className="icon-button" aria-label="Refresh issue" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !issue ? <Loading label="Loading issue…" /> : <>
      <div className="issue-title"><IssueState state={issue.state} /><h2 id="issue-detail-title">{issue.title} <span className="muted">#{issue.number}</span></h2><p className="muted">{issue.user.login} opened this issue on <DateLabel value={issue.created_at} /></p></div>
      <pre className="issue-body" tabIndex={0} aria-label="Issue body, plain text">{issue.body || 'No description provided.'}</pre>
      <div className="issue-footer"><span>{issue.comments} comments · Updated <DateLabel value={issue.updated_at} /></span>{external ? <a className="text-button" href={external} target="_blank" rel="noopener noreferrer">Open in Gitea<ExternalLink size={14} /></a> : null}</div>
      <p className="panel-footnote">Read-only, plain-text view. Comments and issue editing remain in Gitea.</p>
    </>}
  </section>;
}

function IssuesPanel({ base, queryKey, location }: { base: string; queryKey: readonly unknown[]; location: RepositoryLocation }) {
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'issues', location.state], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api<IssuePage>(`${base}/issues?${new URLSearchParams({ state: location.state, page: String(pageParam) })}`, { signal }), getNextPageParam: nextPage });
  const issues = query.isSuccess && (!query.isFetching || query.isFetchingNextPage) ? [...new Map(query.data.pages.flatMap((page) => page.issues).map((issue) => [issue.id, issue])).values()] : [];
  return <section className="browser-panel" aria-labelledby="issues-title">
    <div className="browser-panel-heading"><h2 id="issues-title">Issues</h2><div className="panel-actions"><select aria-label="Issue state" value={location.state} onChange={(event) => navigate(browserHref(location, { state: event.target.value as RepositoryLocation['state'], issue: undefined }))}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All states</option></select><button className="icon-button" aria-label="Refresh issues" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div></div>
    <p className="panel-footnote issue-help">Reading issues requires the additional <code>read:issue</code> token scope. Pull requests are excluded.</p>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading issues…" /> : <>
      <ul className="issue-list">{issues.map((issue) => <li key={issue.id}><CircleDot size={19} /><div><h3><InternalLink href={browserHref(location, { issue: issue.number })}>{issue.title}</InternalLink></h3><p>#{issue.number} · {issue.user.login} · <DateLabel value={issue.created_at} /> · {issue.comments} comments</p></div><IssueState state={issue.state} /></li>)}</ul>
      {!issues.length ? <div className="empty-state"><CircleDot size={25} /><h3>No {location.state === 'all' ? '' : `${location.state} `}issues.</h3><p>There are no issues matching this state.</p></div> : null}
      <div className="list-footer"><span>{issues.length} loaded issues{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="issues" /></div>
    </>}
  </section>;
}

export function RepositoryBrowser({ location, userId }: { location: RepositoryLocation; userId: number }) {
  const base = `/api/repositories/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.name)}`;
  const queryKey = ['repository', userId, location.owner, location.name];
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'metadata'], queryFn: ({ signal }) => api<{ repository: RepositoryDetail }>(base, { signal }) });
  const repository = query.isSuccess && !query.isFetching ? query.data.repository : undefined;
  const external = repository && repositoryLink(repository.html_url);
  const panelProps = { base, queryKey, location, defaultBranch: repository?.default_branch || '' };
  return <div className="repository-browser">
    <InternalLink href="/" className="text-button repository-back"><ArrowLeft size={15} />All repositories</InternalLink>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !repository ? <Loading label="Opening repository…" /> : <>
      <header className="repository-intro"><div><span className="eyebrow">{location.owner} / REPOSITORY</span><h1><BookOpen size={29} />{repository.name}<span className={`visibility ${repository.private ? 'private' : ''}`}>{repository.private ? <LockKeyhole size={11} /> : null}{repository.private ? 'Private' : 'Public'}</span></h1><p>{repository.description || 'No description yet.'}</p></div><div className="panel-actions"><button className="icon-button" aria-label="Refresh repository access" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button>{external ? <a className="button secondary" href={external} target="_blank" rel="noopener noreferrer">Gitea<ExternalLink size={15} /></a> : null}</div></header>
      <nav className="repository-tabs" aria-label="Repository"><InternalLink href={browserHref(location, { view: 'source', issue: undefined })} aria-current={location.view === 'source' ? 'page' : undefined}><BookOpen size={16} />Source</InternalLink><InternalLink href={browserHref(location, { view: 'commits', issue: undefined })} aria-current={location.view === 'commits' ? 'page' : undefined}><GitCommitHorizontal size={17} />Commits</InternalLink><InternalLink href={browserHref(location, { view: 'issues', issue: undefined })} aria-current={location.view === 'issues' ? 'page' : undefined}><CircleDot size={16} />Issues</InternalLink></nav>
      {location.view !== 'issues' && repository.empty ? <section className="browser-panel empty-state"><GitBranch size={29} /><h2>No commits yet.</h2><p>This repository is empty. Push your first commit through Git to add source and branches.</p>{repository.clone_url ? <div className="clone-address"><span>HTTPS clone URL</span><code>{repository.clone_url}</code></div> : null}{repository.ssh_url ? <div className="clone-address"><span>SSH clone URL</span><code>{repository.ssh_url}</code></div> : null}</section> : <>
        {location.view !== 'issues' ? <BranchSelector {...panelProps} /> : null}
        {location.view === 'source' ? <SourcePanel {...panelProps} /> : location.view === 'commits' ? <CommitsPanel {...panelProps} /> : location.issue ? <IssueDetail {...panelProps} /> : <IssuesPanel {...panelProps} />}
      </>}
    </>}
  </div>;
}
