import { useRepositoryLive, RepositoryLiveStatus, RepositoryLiveContext } from './RepositoryLive';
import { DiffViewer } from './DiffViewer';
import { RepositoryReadme } from './RepositoryReadme';
import { CodePreview, FileContent, isMarkdownPath } from './RepositoryContent';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, ChevronRight, CircleDot, Code2, File, Folder, GitBranch, GitCommitHorizontal, GitPullRequest, Link2, LockKeyhole, Play, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useNavigate } from '@tanstack/react-router';
import { repositoryClient } from './api';
import { CommitDiffBase, SourceEntryType } from './gen/golf/v1/golf_pb';
import type { RepositoryKey, SourceEntry } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';

import { DateLabel, Loading, More, PanelError, nextPage, privateQuery, shortSHA } from './RepositoryUI';

const IssueBrowser = lazy(() => import('./IssueBrowser').then((module) => ({ default: module.IssueBrowser })));
const PullRequestBrowser = lazy(() => import('./PullRequestBrowser').then((module) => ({ default: module.PullRequestBrowser })));
const WorkflowRunPage = lazy(() => import('./WorkflowRuns').then(m => ({default:m.WorkflowRunPage})));
const Actions = lazy(() => import('./WorkflowConfigurations').then(m => ({default:m.WorkflowConfigurations})));
const isCommit = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

function Size({ value }: { value: bigint }) {
  const units = [[1024n ** 6n, 'EiB'], [1024n ** 5n, 'PiB'], [1024n ** 4n, 'TiB'], [1024n ** 3n, 'GiB'], [1024n ** 2n, 'MiB'], [1024n, 'KiB']] as const;
  const unit = units.find(([bytes]) => value >= bytes);
  const tenths = unit ? (value * 10n + unit[0] / 2n) / unit[0] : 0n;
  return <span title={`${value} bytes`}>{unit ? `${tenths / 10n}.${tenths % 10n} ${unit[1]}` : `${value} B`}</span>;
}

function entryTypeLabel(type: SourceEntryType) {
  return type === SourceEntryType.DIRECTORY ? 'Directory' : type === SourceEntryType.FILE ? 'File' : type === SourceEntryType.SYMLINK ? 'Symlink' : type === SourceEntryType.SUBMODULE ? 'Submodule' : 'Unknown';
}


function BranchSelector({ repositoryKey, queryKey, location, defaultBranch }: { repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const navigate = useNavigate();
  const details = useRef<HTMLDetailsElement>(null);
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'branches'], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listBranches({ repository: repositoryKey, page: { page: pageParam } }, { signal }), getNextPageParam: nextPage });
  const branches = [...new Map(query.data?.pages.flatMap((page) => page.branches).map((branch) => [branch.name, branch])).values()];
  const branchName = location.branch || (!location.ref ? defaultBranch : '');
  return <div className="ref-controls">
    <details className="ref-picker branch-picker" ref={details}>
      <summary><GitBranch size={16} /><span>{branchName || (isCommit(location.ref) ? 'Selected commit' : location.ref) || defaultBranch}</span><ChevronRight size={14} /></summary>
      <div className="branch-options"><strong>Choose a branch</strong><p className="field-help">Selection opens its current commit. More branches may be available below.</p>
        {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading branches…" /> : <>
          <ul>{branches.map((branch) => <li key={branch.name}><Link {...repositoryOptions(location, { ref: branch.name, branch: branch.name, path: '' })} onClick={() => { if (details.current) details.current.open = false; }}><GitBranch size={15} /><span>{branch.name}<small>Listed at {shortSHA(branch.commitId)}</small></span>{branch.protected ? <ShieldCheck size={15} aria-label="Protected branch" /> : null}</Link></li>)}</ul>
          {!branches.length ? <p className="muted">No branches available.</p> : null}
          <More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="branches" />
        </>}
      </div>
    </details>
    {location.ref && isCommit(location.ref) ? <span className="commit-pin" title={location.ref}><LockKeyhole size={12} />{shortSHA(location.ref)}</span> : <span className="field-help">Resolving a commit…</span>}
    {branchName ? <button className="text-button branch-refresh" onClick={() => void navigate(repositoryOptions(location, { ref: branchName, branch: branchName }))}><RefreshCw size={14} />Latest branch head</button> : null}
  </div>;
}

function EntryIcon({ type }: { type: SourceEntry['type'] }) {
  const Icon = type === SourceEntryType.DIRECTORY ? Folder : type === SourceEntryType.FILE ? File : type === SourceEntryType.SYMLINK ? Link2 : GitCommitHorizontal;
  return <Icon size={18} aria-hidden="true" />;
}

function SourcePanel({ repositoryKey, queryKey, location, defaultBranch }: { repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const navigate = useNavigate();
  const ref = location.ref || defaultBranch;
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'source', ref, location.path],
    queryFn: ({ signal }) => repositoryClient.getContents({ repository: repositoryKey, ref, path: location.path }, { signal }) });
  const source = query.isSuccess && !query.isFetching ? query.data : undefined;
  useEffect(() => {
    if (source && source.commitId !== location.ref) void navigate({ ...repositoryOptions(location, { ref: source.commitId, branch: location.branch || (!location.ref ? defaultBranch : isCommit(location.ref) ? '' : location.ref) }), replace: true });
  }, [source, location, defaultBranch, navigate]);
  const selectedRef = source?.commitId || ref;
  const crumbs = location.path.split('/').filter(Boolean);
  return <section aria-labelledby="source-title" className="browser-panel">
    <div className="browser-panel-heading source-panel-heading"><h2 id="source-title">Source</h2><button className="icon-button manual-refresh" aria-label="Refresh source" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} className={query.isFetching ? 'spin' : ''} /></button></div>
    <nav className={`source-breadcrumbs ${location.path ? "" : "source-root-path"}`} aria-label="Source path"><Link {...repositoryOptions(location, { ref: selectedRef, path: '' })}>{location.name}</Link>{crumbs.map((crumb, index) => <span key={index}><ChevronRight size={13} /><Link {...repositoryOptions(location, { ref: selectedRef, path: crumbs.slice(0, index + 1).join('/') })} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>{crumb}</Link></span>)}</nav>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !source ? <Loading label="Reading source…" /> : source.kind === SourceEntryType.DIRECTORY ? <>
      {source.entries?.length ? <ul className="source-tree">{[...source.entries].sort((a,b)=>Number(b.type===SourceEntryType.DIRECTORY)-Number(a.type===SourceEntryType.DIRECTORY)||a.name.localeCompare(b.name)).map((entry) => <li key={entry.path}><Link {...repositoryOptions(location, { ref: source.commitId, path: entry.path },entry.type===SourceEntryType.FILE?'file':undefined)}><EntryIcon type={entry.type} /><span className="source-name">{entry.name}</span><span className="entry-type">{entryTypeLabel(entry.type)}</span>{entry.type !== SourceEntryType.DIRECTORY ? <Size value={entry.size} /> : <span /> }<ChevronRight size={14} /></Link></li>)}</ul> : <div className="empty-state"><Folder size={25} /><h3>This directory is empty.</h3></div>}
      <p className="panel-footnote">{source.entries?.length || 0} entries · Read-only snapshot at <code>{shortSHA(source.commitId)}</code></p>
      <RepositoryReadme owner={repositoryKey.owner} name={repositoryKey.name} refId={source.commitId} path={location.path} entries={source.entries} userId={String(queryKey[1]||'')}/>
    </> : source.file?.entry ? <>
      <div className="file-meta"><span><EntryIcon type={source.file.entry.type} />{entryTypeLabel(source.file.entry.type).toLowerCase()}</span><Size value={source.file.entry.size} /><span>Object <code title={source.file.entry.sha}>{shortSHA(source.file.entry.sha)}</code></span></div>
      {source.file.entry.type === SourceEntryType.FILE && source.file.content !== undefined && !source.file.previewReason && source.file.entry.size <= 256n * 1024n ? isMarkdownPath(source.file.entry.name) ? <FileContent key={source.file.entry.sha} text={source.file.content} path={source.file.entry.path} context={{owner:repositoryKey.owner,name:repositoryKey.name,ref:source.commitId,path:source.file.entry.path,userId:String(queryKey[1])}}/> : <CodePreview text={source.file.content || '(Empty text file)'} path={source.file.entry.name} label={`Plain text preview of ${source.file.entry.name}`}/> : <div className="preview-unavailable"><File size={26} /><h3>Preview unavailable</h3><p>{source.file.previewReason || 'This file is outside the supported plain-text preview limits.'}</p><p className="muted">Previews support UTF-8 text up to 256 KiB. Binary, large, LFS, symlink and submodule content is not opened.</p></div>}
      <p className="panel-footnote">Rendered Markdown or highlighted source · Read-only snapshot at <code>{shortSHA(source.commitId)}</code></p>
    </> : <p className="error" role="alert">The source response did not contain file metadata.</p>}
  </section>;
}

function CommitsPanel({ repositoryKey, queryKey, location, defaultBranch }: { repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const navigate = useNavigate();
  const ref = location.ref || defaultBranch;
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'commits', ref], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listCommits({ repository: repositoryKey, ref, page: { page: pageParam } }, { signal }), getNextPageParam: nextPage });
  const commits = query.isSuccess && (!query.isFetching || query.isFetchingNextPage) ? [...new Map(query.data.pages.flatMap((page) => page.commits).map((commit) => [commit.sha, commit])).values()] : [];
  const head = commits[0]?.sha;
  useEffect(() => {
    if (head && !isCommit(location.ref)) void navigate({ ...repositoryOptions(location, { ref: head, branch: location.branch || location.ref || defaultBranch }), replace: true });
  }, [head, location, defaultBranch, navigate]);
  return <section aria-labelledby="commits-title" className="browser-panel">
    <div className="browser-panel-heading"><h2 id="commits-title">Commit history</h2><button className="icon-button manual-refresh" aria-label="Refresh commits" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading commits…" /> : <>
      <ol className="commit-list">{commits.map((commit) => <li key={commit.sha}><GitCommitHorizontal size={20} /><div><h3>{commit.message.split('\n')[0] || 'Untitled commit'}</h3><p>{commit.authorName || 'Unknown author'} · <DateLabel value={commit.authoredAt} /></p>{commit.message.includes('\n') ? <details className="commit-message"><summary>Full commit message</summary><pre>{commit.message}</pre></details> : null}<Link className="text-button commit-diff-link" {...repositoryOptions(location, { commit: commit.sha })} aria-label={`View diff ${shortSHA(commit.sha)}`}>View diff<ChevronRight size={13} /></Link></div><Link className="sha-link" {...repositoryOptions(location, { view: 'source', ref: commit.sha, branch: '', path: '' })} aria-label={`Browse commit ${shortSHA(commit.sha)}`} title={commit.sha}>{shortSHA(commit.sha)}<ChevronRight size={14} /></Link></li>)}</ol>
      {!commits.length ? <div className="empty-state"><GitCommitHorizontal size={25} /><h3>No commits at this ref.</h3></div> : null}
      <div className="list-footer"><span>{commits.length} loaded commits{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="commits" /></div>
    </>}
    <p className="panel-footnote">View a commit’s native diff or browse its source snapshot.</p>
  </section>;
}

function CommitDiffPanel({ repositoryKey, queryKey, location }: { repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation }) {
  const commitId = location.commit!;
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'commit-diff', commitId],
    queryFn: async ({ signal }) => {
      const response = await repositoryClient.getCommitDiff({ repository: repositoryKey, commitId }, { signal, timeoutMs: 8_000 });
      if (!response.commit || response.commit.sha !== commitId || ![CommitDiffBase.ROOT, CommitDiffBase.FIRST_PARENT].includes(response.base)) throw new ConnectError('The diff response does not identify the requested commit and comparison.', Code.Internal);
      if (response.rawDiff.length > 512 * 1024 || response.byteSize > 512 * 1024 || new TextEncoder().encode(response.rawDiff).byteLength !== response.byteSize) throw new ConnectError('The diff response exceeds its supported text bounds.', Code.ResourceExhausted);
      return response;
    },
  });
  const diff = query.isSuccess && !query.isFetching ? query.data : undefined;
  return <>
    <div className="commit-diff-navigation"><Link className="text-button" {...repositoryOptions(location, { commit: undefined })}><ArrowLeft size={15} />Back to commit history</Link><Link className="text-button" {...repositoryOptions(location, { view: 'source', ref: commitId, branch: '', path: '' })}>Browse this commit<ChevronRight size={15} /></Link></div>
    <section className="browser-panel" aria-labelledby="commit-diff-title">
      <div className="browser-panel-heading"><h2 id="commit-diff-title">Commit diff</h2><button className="icon-button manual-refresh" aria-label="Refresh diff" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>
      {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !diff ? <Loading label="Loading commit diff…" /> : <>
        <div className="commit-diff-metadata"><h3>{diff.commit!.message.split('\n')[0] || 'Untitled commit'}</h3><p>{diff.commit!.authorName || 'Unknown author'} · <DateLabel value={diff.commit!.authoredAt}/> · <code>{shortSHA(diff.commit!.sha)}</code></p><details className="metadata-details" open={diff.base === CommitDiffBase.ROOT || diff.parentCommitIds.length > 1}><summary>Commit details</summary><dl><div><dt>Commit</dt><dd><code>{diff.commit!.sha}</code></dd></div><div><dt>Comparison</dt><dd>{diff.base === CommitDiffBase.ROOT ? 'Root commit · no parent' : 'First parent'}{diff.baseCommitId ? <code>{diff.baseCommitId}</code> : null}</dd></div><div><dt>Parents</dt><dd>{diff.parentCommitIds.length ? diff.parentCommitIds.map((id) => <code key={id}>{id}</code>) : 'None'}</dd></div><div><dt>Author</dt><dd>{diff.commit!.authorName || 'Unknown author'} · <DateLabel value={diff.commit!.authoredAt} /></dd></div></dl>
          <pre className="commit-diff-message" tabIndex={0} aria-label="Commit message, plain text">{diff.commit!.message || '(No commit message)'}</pre>
          {diff.parentCommitIds.length > 1 ? <p>Merge commit: only the first-parent comparison is shown.</p> : null}
          {diff.base === CommitDiffBase.ROOT ? <p>Root output may include Git’s commit header before the patch.</p> : null}
        </details></div>
        {diff.rawDiff ? <DiffViewer key={`${String(queryKey[1])}-${commitId}`} text={diff.rawDiff} snapshotId={commitId}/> : <div className="empty-state"><GitCommitHorizontal size={25} /><h3>No diff text returned</h3><p>The provider returned empty output for this commit.</p></div>}
        <p className="panel-footnote">{diff.byteSize.toLocaleString()} bytes · Repository diff output, plain text; not merge eligibility or independently verified patch evidence. Binary content is not expanded. Text is limited to 512 KiB; larger responses are refused.</p>
      </>}
    </section>
  </>;
}

export function RepositoryBrowser({ location, userId }: { location: RepositoryLocation; userId: string }) {
  const repositoryKey = { owner: location.owner, name: location.name };
  const queryKey = ['repository', userId, location.owner, location.name];
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'metadata'], queryFn: ({ signal }) => repositoryClient.getRepository({ repository: repositoryKey }, { signal }).then((response) => { if (!response.repository) throw new ConnectError('The repository response is missing its metadata.', Code.Internal); return response.repository; }) });
  const live=useRepositoryLive(userId,location.owner,location.name,query.data?.id,location.ref,query.isSuccess&&!query.isError,location.view==='pulls'&&location.pullView==='files');
  const repository = query.isSuccess ? query.data : undefined;
  const panelProps = { repositoryKey, queryKey, location, defaultBranch: repository?.defaultBranch || '' };
  return <RepositoryLiveContext value={live.status}><div className={`repository-browser ${live.status==='live'?'live-connected':''}`}>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !repository ? <Loading label="Opening repository…" /> : <>{query.isFetching ? <Loading label="Checking repository access…"/> : null}<div className="repository-authorized-content" hidden={query.isFetching}>
      <header className="repository-intro repository-work-header"><div><h1><BookOpen size={20} /><span className="repository-owner">{location.owner}</span><span className="repository-title-slash">/</span>{repository.name}<span className={`visibility ${repository.private ? 'private' : ''}`}>{repository.private ? <LockKeyhole size={11} /> : null}{repository.private ? 'Private' : 'Public'}</span></h1></div><div className="panel-actions"><RepositoryLiveStatus status={live.status} reconnect={live.reconnect}/><button className="icon-button manual-refresh" aria-label="Refresh repository access" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div></header>
      {live.newSource?<p className="source-update-notice" role="status"><GitCommitHorizontal size={15}/>{location.view==='pulls'&&location.pullView==='files'?<>Repository activity changed. This comparison stays pinned.<button className="text-button" onClick={live.refreshComparison}>Refresh comparison</button></>:<>New repository activity is available. This source snapshot stays pinned; choose Latest branch head to view new code.</>}</p>:null}
      <nav className="repository-tabs" aria-label="Repository"><Link {...repositoryOptions(location, { view: 'source', issue: undefined })} aria-current={location.view === 'source' ? 'page' : undefined}><Code2 size={16} />Code</Link><Link {...repositoryOptions(location, { view: 'commits', issue: undefined, commit: undefined })} aria-current={location.view === 'commits' ? 'page' : undefined}><GitCommitHorizontal size={17} />Commits</Link><Link {...repositoryOptions(location, { view: 'issues', issue: undefined })} aria-current={location.view === 'issues' ? 'page' : undefined}><CircleDot size={16} />Issues</Link><Link {...repositoryOptions(location, { view: 'pulls', pull: undefined })} aria-current={location.view === 'pulls' ? 'page' : undefined}><GitPullRequest size={16} />Pull requests</Link><Link {...repositoryOptions(location, { view: 'actions',run:undefined })} aria-current={location.view === 'actions' ? 'page' : undefined}><Play size={16}/>Actions</Link><Link to="/repositories/$owner/$name/settings" params={{owner:location.owner,name:location.name}}><Settings size={16}/>Settings</Link></nav>
      {(location.view === 'source' || location.view === 'commits') && repository.empty ? <section className="browser-panel empty-state"><GitBranch size={29} /><h2>No commits yet.</h2><p>This repository is empty. Push your first commit through Git to add source and branches.</p>{repository.cloneUrl ? <div className="clone-address"><span>HTTPS clone URL</span><code>{repository.cloneUrl}</code></div> : null}{repository.sshUrl ? <div className="clone-address"><span>SSH clone URL</span><code>{repository.sshUrl}</code></div> : null}</section> : <>
        {location.view === 'source' || location.view === 'commits' && !location.commit ? <div className="repository-code-toolbar"><BranchSelector {...panelProps}/>{location.view === 'source' && (repository.cloneUrl || repository.sshUrl) ? <details className="ref-picker clone-picker"><summary><Code2 size={16}/>Code<ChevronRight size={14}/></summary><div className="branch-options clone-options"><strong>Clone this repository</strong>{repository.cloneUrl ? <><span className="field-help">HTTPS</span><code>{repository.cloneUrl}</code></> : null}{repository.sshUrl ? <><span className="field-help">SSH</span><code>{repository.sshUrl}</code></> : null}<Link to="/account/ssh-keys">Manage SSH keys</Link></div></details> : null}</div> : null}
        {location.view === 'source' ? <div className={!location.path ? 'repository-source-layout' : undefined}><SourcePanel {...panelProps}/>{!location.path ? <aside className="repository-about" aria-label="About this repository"><h2>About</h2><p>{repository.description || 'No description provided.'}</p><dl><div><dt>Visibility</dt><dd>{repository.private ? 'Private' : 'Public'}</dd></div><div><dt>Default branch</dt><dd><GitBranch size={14}/>{repository.defaultBranch}</dd></div><div><dt>Updated</dt><dd><DateLabel value={repository.updatedAt}/></dd></div></dl><Link className="text-button" {...repositoryOptions(location,{view:'commits',commit:undefined})}><GitCommitHorizontal size={15}/>Commit history</Link></aside> : null}</div> : location.view === 'commits' ? location.commit ? <CommitDiffPanel key={location.commit} {...panelProps} /> : <CommitsPanel {...panelProps} /> : location.view === 'actions' ? <Suspense fallback={<Loading label="Opening Actions…"/>}>{location.run ? <WorkflowRunPage key={location.run} userId={userId} owner={location.owner} name={location.name} repositoryId={repository.id} runId={location.run} signingOut={false}/> : <Actions userId={userId} owner={location.owner} name={location.name} signingOut={false} workView/>}</Suspense> : location.view === 'pulls' ? <Suspense fallback={<Loading label="Opening pull requests…" />}><PullRequestBrowser {...panelProps} repositoryId={repository.id} userId={userId}/></Suspense> : <Suspense fallback={<Loading label="Opening issues…" />}><IssueBrowser key={repository.id} {...panelProps} repositoryId={repository.id} userId={userId} /></Suspense>}
      </>}
    </div></>}
  </div></RepositoryLiveContext>;
}
