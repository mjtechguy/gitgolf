import { RepositoryCommitSummary } from './RepositoryCommitSummary';
import { RepositoryRefs } from './RepositoryRefs';
import { SourceEntryCommit } from './SourceEntryCommit';
import { SourceActions } from './SourceActions';
import { CommitList } from './CommitList';
import { useRepositoryLive, RepositoryLiveStatus, RepositoryLiveContext } from './RepositoryLive';
import { DiffViewer } from './DiffViewer';
import { RepositoryReadme } from './RepositoryReadme';
import { CodePreview, FileContent, isMarkdownPath } from './RepositoryContent';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, ChevronRight, CircleDot, Code2, File, Folder, GitBranch, GitCommitHorizontal, GitPullRequest, Link2, LockKeyhole, Play, RefreshCw, Settings } from 'lucide-react';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { repositoryClient } from './api';
import { CommitDiffBase, SourceEntryType } from './gen/golf/v1/golf_pb';
import type { RepositoryKey, SourceEntry } from './gen/golf/v1/golf_pb';
import { repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';

import { CopyButton, disclosureDismiss, RepositoryTabs, DateLabel, Loading, More, PanelError, nextPage, privateQuery, shortSHA } from './RepositoryUI';

const SourceNavigator=lazy(()=>import('./SourceNavigator').then(m=>({default:m.SourceNavigator})));
const RepositoryCompare = lazy(()=>import('./RepositoryCompare').then(m=>({default:m.RepositoryCompare})));
const IssueBrowser = lazy(() => import('./IssueBrowser').then((module) => ({ default: module.IssueBrowser })));
const PullRequestBrowser = lazy(() => import('./PullRequestBrowser').then((module) => ({ default: module.PullRequestBrowser })));
const WorkflowRunPage = lazy(() => import('./WorkflowRuns').then(m => ({default:m.WorkflowRunPage})));
const Actions = lazy(() => import('./WorkflowConfigurations').then(m => ({default:m.WorkflowConfigurations})));
const isCommit = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

function Size({ value, className }: { value: bigint; className?: string }) {
  const units = [[1024n ** 6n, 'EiB'], [1024n ** 5n, 'PiB'], [1024n ** 4n, 'TiB'], [1024n ** 3n, 'GiB'], [1024n ** 2n, 'MiB'], [1024n, 'KiB']] as const;
  const unit = units.find(([bytes]) => value >= bytes);
  const tenths = unit ? (value * 10n + unit[0] / 2n) / unit[0] : 0n;
  return <span className={className} title={`${value} bytes`}>{unit ? `${tenths / 10n}.${tenths % 10n} ${unit[1]}` : `${value} B`}</span>;
}

function entryTypeLabel(type: SourceEntryType) {
  return type === SourceEntryType.DIRECTORY ? 'Directory' : type === SourceEntryType.FILE ? 'File' : type === SourceEntryType.SYMLINK ? 'Symlink' : type === SourceEntryType.SUBMODULE ? 'Submodule' : 'Unknown';
}



function CloneMenu({ https, ssh }: { https: string; ssh: string }) {
  const [protocol, setProtocol] = useState(https ? 'https' : 'ssh');
  const useHTTPS = protocol === 'https' && Boolean(https) || !ssh;
  const address = useHTTPS ? https : ssh;
  return <details className="ref-picker clone-picker" {...disclosureDismiss}><summary><Code2 size={16} aria-hidden="true"/>Code<ChevronRight size={14} aria-hidden="true"/></summary><div className="branch-options clone-options"><strong>Clone this repository</strong><div className="content-view-controls" role="group" aria-label="Clone protocol">{https ? <button type="button" className="text-button" aria-pressed={useHTTPS} onClick={() => setProtocol('https')}>HTTPS</button> : null}{ssh ? <button type="button" className="text-button" aria-pressed={!useHTTPS} onClick={() => setProtocol('ssh')}>SSH</button> : null}</div><div className="copy-field"><input aria-label={`${useHTTPS ? 'HTTPS' : 'SSH'} clone URL`} value={address} readOnly spellCheck={false} onFocus={event => event.currentTarget.select()}/><CopyButton key={address} text={address} label={`Copy ${useHTTPS ? 'HTTPS' : 'SSH'} clone URL`}/></div><p className="field-help">{useHTTPS ? 'Clone using the repository URL.' : 'Clone using an SSH key connected to your account.'}</p><Link to="/account/ssh-keys">Manage SSH keys</Link></div></details>;
}

function EntryIcon({ type }: { type: SourceEntry['type'] }) {
  const Icon = type === SourceEntryType.DIRECTORY ? Folder : type === SourceEntryType.FILE ? File : type === SourceEntryType.SYMLINK ? Link2 : GitCommitHorizontal;
  return <Icon size={18} aria-hidden="true" />;
}

function SourcePanel({ repositoryKey, queryKey, location, defaultBranch,repositoryId }: { repositoryId:string; repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const navigate = useNavigate();
  const router = useRouter();
  const ref = location.ref || defaultBranch;
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'source', ref, location.path],
    queryFn: ({ signal }) => repositoryClient.getContents({ repository: repositoryKey, ref, path: location.path }, { signal }) });
  const source = query.isSuccess && !query.isFetching ? query.data : undefined;
  useEffect(() => {
    if (!source) return;
    // Navigation updates Router before this panel's props. Do not normalize a
    // previous source receipt over a newly selected path or another work tab.
    const current = router.state.location;
    const tree = router.buildLocation(repositoryOptions(location)).pathname;
    const blob = router.buildLocation(repositoryOptions(location, {}, 'file')).pathname;
    const legacy = router.buildLocation({ to: '/repositories/$owner/$name', params: { owner: location.owner, name: location.name }, search: location }).pathname;
    if (current.pathname !== tree && current.pathname !== blob && current.pathname !== legacy) return;
    if ((current.pathname === legacy || !isCommit(location.ref)) && ((current.search.view || 'source') !== location.view || (current.search.ref || '') !== location.ref || (current.search.path || '') !== location.path)) return;
    const target = repositoryOptions(location, { ref: source.commitId, branch: location.tag ? '' : location.branch || (!location.ref ? defaultBranch : isCommit(location.ref) ? '' : location.ref) }, source.kind !== SourceEntryType.DIRECTORY ? 'file' : undefined);
    if (source.commitId !== location.ref || router.buildLocation(target).pathname !== router.state.location.pathname) void navigate({ ...target, hash: current.hash, replace: true });
  }, [source, location, defaultBranch, navigate, router]);
  const selectedRef = source?.commitId || ref;
  const crumbs = location.path.split('/').filter(Boolean);
  return <div className={location.path?"source-file-layout":undefined}>{location.path&&source?<Suspense fallback={<Loading label="Opening file navigation…"/>}><SourceNavigator location={location} commitId={source.commitId} repositoryId={repositoryId} userId={String(queryKey[1]||'')}/></Suspense>:null}<section aria-labelledby="source-title" className="browser-panel">
    <div className="browser-panel-heading source-panel-heading"><h2 id="source-title" className="sr-only">Source</h2>{source?<RepositoryCommitSummary location={location} repositoryId={repositoryId} commitId={source.commitId} userId={String(queryKey[1]||'')}/>:null}{source?<SourceActions location={location} commitId={source.commitId} path={source.path} file={source.kind!==SourceEntryType.DIRECTORY} text={source.file?.entry?.type===SourceEntryType.FILE&&!source.file.previewReason&&source.file.entry.size<=256n*1024n?source.file.content:undefined}/>:null}<button className="icon-button manual-refresh" aria-label="Refresh source" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} className={query.isFetching ? 'spin' : ''} /></button></div>
    <nav className={`source-breadcrumbs ${location.path ? "" : "source-root-path"}`} aria-label="Source path"><Link {...repositoryOptions(location, { ref: selectedRef, path: '' })}>{location.name}</Link>{crumbs.map((crumb, index) => <span key={index}><ChevronRight size={13} /><Link {...repositoryOptions(location, { ref: selectedRef, path: crumbs.slice(0, index + 1).join('/') })} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>{crumb}</Link></span>)}</nav>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !source ? <Loading label="Reading source…" /> : source.kind === SourceEntryType.DIRECTORY ? <>
      {source.entries?.length ? <ul className="source-tree source-tree-with-commits">{[...source.entries].sort((a,b)=>Number(b.type===SourceEntryType.DIRECTORY)-Number(a.type===SourceEntryType.DIRECTORY)||a.name.localeCompare(b.name)).map((entry) => <li key={entry.path}><Link title={entry.path} {...repositoryOptions(location, { ref: source.commitId, path: entry.path },entry.type!==SourceEntryType.DIRECTORY?'file':undefined)}><EntryIcon type={entry.type} /><span className="source-name">{entry.name}</span><span className="entry-type sr-only">{entryTypeLabel(entry.type)}</span>{entry.type !== SourceEntryType.DIRECTORY ? <Size value={entry.size} className="sr-only" /> : <span className="sr-only" /> }<ChevronRight size={14} /></Link><SourceEntryCommit userId={String(queryKey[1]||'')} repositoryId={repositoryId} commitId={source.commitId} path={entry.path} location={location}/></li>)}</ul> : <div className="empty-state"><Folder size={25} /><h3>This directory is empty.</h3></div>}
      <p className="panel-footnote">{source.entries?.length || 0} entries · Read-only snapshot at <code>{shortSHA(source.commitId)}</code></p>
      <RepositoryReadme owner={repositoryKey.owner} name={repositoryKey.name} refId={source.commitId} path={location.path} entries={source.entries} userId={String(queryKey[1]||'')}/>
    </> : source.file?.entry ? <>
      <div className="file-meta"><span><EntryIcon type={source.file.entry.type} />{entryTypeLabel(source.file.entry.type).toLowerCase()}</span><Size value={source.file.entry.size} /><span>Object <code title={source.file.entry.sha}>{shortSHA(source.file.entry.sha)}</code></span></div>
      {source.file.entry.type === SourceEntryType.FILE && source.file.content !== undefined && !source.file.previewReason && source.file.entry.size <= 256n * 1024n ? isMarkdownPath(source.file.entry.name) ? <FileContent key={source.file.entry.sha} text={source.file.content} path={source.file.entry.path} context={{owner:repositoryKey.owner,name:repositoryKey.name,ref:source.commitId,path:source.file.entry.path,userId:String(queryKey[1])}}/> : <CodePreview text={source.file.content} path={source.file.entry.name} label={`Plain text preview of ${source.file.entry.name}`}/> : <div className="preview-unavailable"><File size={26} /><h3>Preview unavailable</h3><p>{source.file.previewReason || 'This file is outside the supported plain-text preview limits.'}</p><p className="muted">Previews support UTF-8 text up to 256 KiB. Binary, large, LFS, symlink and submodule content is not opened.</p></div>}
      <p className="panel-footnote">Rendered Markdown or highlighted source · Read-only snapshot at <code>{shortSHA(source.commitId)}</code></p>
    </> : <p className="error" role="alert">The source response did not contain file metadata.</p>}
  </section></div>;
}

function CommitsPanel({ repositoryKey, queryKey, location, defaultBranch,repositoryId }: { repositoryId:string; repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const navigate = useNavigate();
  const ref = location.ref || defaultBranch;
  const query = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'commits', ref,location.historyPath||'',repositoryId], initialPageParam: 1,
    queryFn: async({ pageParam, signal }) => {const path=location.historyPath||'';const response=await repositoryClient.listCommits({ repository: repositoryKey, ref,path,repositoryId: isCommit(ref) ? repositoryId : '', page: { page: pageParam } }, { signal });if(path&&(response.path!==path||response.commitId!==ref||response.repositoryId!==repositoryId))throw new ConnectError('The returned history does not match this path and snapshot.',Code.FailedPrecondition);return response;}, getNextPageParam: nextPage });
  const commits = query.isSuccess && (!query.isFetching || query.isFetchingNextPage) ? [...new Map(query.data.pages.flatMap((page) => page.commits).map((commit) => [commit.sha, commit])).values()] : [];
  const head = commits[0]?.sha;
  useEffect(() => {
    if (head && !isCommit(location.ref)) void navigate({ ...repositoryOptions(location, { ref: head, branch: location.branch || location.ref || defaultBranch }), replace: true });
  }, [head, location, defaultBranch, navigate]);
  return <section aria-labelledby="commits-title" className="browser-panel commit-history">
    <div className="browser-panel-heading"><h2 id="commits-title">Commit history</h2><button className="icon-button manual-refresh" aria-label="Refresh commits" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>{location.historyPath?<div className="source-history-heading"><Link className="text-button" {...repositoryOptions(location,{view:'source',ref,path:location.historyPath,historyPath:undefined})}><ArrowLeft size={15}/>Back to source</Link><code>{location.historyPath}</code><span className="muted">History for this literal path; earlier names are not followed.</span></div>:null}
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading commits…" /> : <>
      <CommitList commits={commits} location={location}/>
      {!commits.length ? <div className="empty-state"><GitCommitHorizontal size={25} /><h3>No commits at this ref.</h3></div> : null}
      <div className="list-footer"><span>{commits.length} loaded commits{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="commits" /></div>
    </>}
    <p className="panel-footnote">View a commit’s native diff or browse its source snapshot.</p>
  </section>;
}

function CommitDiffPanel({ repositoryKey, queryKey, location, repositoryId }: { repositoryId:string; repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation }) {
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
        {diff.rawDiff ? <DiffViewer key={`${String(queryKey[1])}-${repositoryId}-${commitId}`} text={diff.rawDiff} snapshotId={commitId}/> : <div className="empty-state"><GitCommitHorizontal size={25} /><h3>No diff text returned</h3><p>The provider returned empty output for this commit.</p></div>}
        <p className="panel-footnote">{diff.byteSize.toLocaleString()} bytes · Repository diff output, plain text; not merge eligibility or independently verified patch evidence. Binary content is not expanded. Text is limited to 512 KiB; larger responses are refused.</p>
      </>}
    </section>
  </>;
}

export function RepositoryBrowser({ location, userId }: { location: RepositoryLocation; userId: string }) {
  const repositoryKey = { owner: location.owner, name: location.name };
  const queryKey = ['repository', userId, location.owner, location.name];
  const query = useQuery({ ...privateQuery, queryKey: [...queryKey, 'metadata'], queryFn: ({ signal }) => repositoryClient.getRepository({ repository: repositoryKey }, { signal }).then((response) => { if (!response.repository) throw new ConnectError('The repository response is missing its metadata.', Code.Internal); return response.repository; }) });
  const live=useRepositoryLive(userId,location.owner,location.name,query.data?.id,location.ref,query.isSuccess&&!query.isError,location.view==='compare'||location.view==='pulls'&&Boolean(location.pull)&&location.pullView!==undefined&&location.pullView!=='conversation');
  const repository = query.isSuccess ? query.data : undefined;
  const disabledFeature = location.view === 'issues' && repository?.issuesEnabled === false ? 'Issues' : (location.view === 'pulls' || location.view === 'compare') && repository?.pullRequestsEnabled === false ? 'Pull requests' : '';
  const panelProps = { repositoryKey, queryKey, location, defaultBranch: repository?.defaultBranch || '',repositoryId:repository?.id||'' };
  return <RepositoryLiveContext value={live.status}><div className={`repository-browser ${live.status==='live'?'live-connected':''}`}>
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !repository ? <Loading label="Opening repository…" /> : <>{query.isFetching ? <Loading label="Checking repository access…"/> : null}<div className="repository-authorized-content" hidden={query.isFetching}>
      <header className="repository-intro repository-work-header"><div><h1><BookOpen size={20} /><span className="repository-owner">{location.owner}</span><span className="repository-title-slash">/</span>{repository.name}<span className={`visibility ${repository.private ? 'private' : ''}`}>{repository.private ? <LockKeyhole size={11} /> : null}{repository.private ? 'Private' : 'Public'}</span></h1></div><div className="panel-actions"><RepositoryLiveStatus status={live.status} reconnect={live.reconnect}/><button className="icon-button manual-refresh" aria-label="Refresh repository access" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div></header>
      {live.newSource?<p className="source-update-notice" role="status"><GitCommitHorizontal size={15}/>{location.view==='compare'||location.view==='pulls'&&Boolean(location.pull)&&location.pullView!==undefined&&location.pullView!=='conversation'?<>Repository activity changed. This comparison stays pinned.<button className="text-button" onClick={live.refreshComparison}>Refresh comparison</button></>:<>New repository activity is available. This source snapshot stays pinned; choose Latest branch head to view new code.</>}</p>:null}
      <RepositoryTabs label="Repository" selection={location.view}><Link {...repositoryOptions(location, { view: 'source', issue: undefined })} aria-current={location.view === 'source' ? 'page' : undefined}><Code2 size={16} />Code</Link><Link {...repositoryOptions(location, { view: 'commits', issue: undefined, commit: undefined,historyPath:undefined })} aria-current={location.view === 'commits' ? 'page' : undefined}><GitCommitHorizontal size={17} />Commits</Link>{repository.issuesEnabled !== false ? <Link {...repositoryOptions(location, { view: 'issues', issue: undefined,issueNew:undefined })} aria-current={location.view === 'issues' ? 'page' : undefined}><CircleDot size={16} />Issues</Link> : null}{repository.pullRequestsEnabled !== false ? <Link {...repositoryOptions(location, { view: 'pulls', pull: undefined })} aria-current={location.view === 'pulls' || location.view === 'compare' ? 'page' : undefined}><GitPullRequest size={16} />Pull requests</Link> : null}<Link {...repositoryOptions(location, { view: 'actions',run:undefined })} aria-current={location.view === 'actions' ? 'page' : undefined}><Play size={16}/>Actions</Link><Link to="/$owner/$name/settings" params={{owner:location.owner,name:location.name}}><Settings size={16}/>Settings</Link></RepositoryTabs>
      {disabledFeature ? <section className="browser-panel empty-state"><Settings size={25}/><h2>{disabledFeature} are disabled</h2><p>This repository has this feature turned off.</p><Link className="button secondary" {...repositoryOptions(location, { view: 'source' })}>Back to code</Link></section> : (location.view === 'source' || location.view === 'commits') && repository.empty ? <section className="browser-panel empty-state"><GitBranch size={29} /><h2>No commits yet.</h2><p>This repository is empty. Push your first commit through Git to add source and branches.</p>{repository.cloneUrl ? <div className="clone-address"><span>HTTPS clone URL</span><code>{repository.cloneUrl}</code></div> : null}{repository.sshUrl ? <div className="clone-address"><span>SSH clone URL</span><code>{repository.sshUrl}</code></div> : null}</section> : <>
        {location.view === 'source' || location.view === 'commits' && !location.commit && !location.historyPath ? <div className="repository-code-toolbar"><RepositoryRefs {...panelProps}/>{location.view === 'source' && (repository.cloneUrl || repository.sshUrl) ? <CloneMenu https={repository.cloneUrl} ssh={repository.sshUrl}/> : null}</div> : null}
        {location.view==='compare'?<Suspense fallback={<Loading label="Opening comparison…"/>}><RepositoryCompare key={repository.id} {...panelProps} repository={repository} userId={userId}/></Suspense>:location.view === 'source' ? <div className={!location.path ? 'repository-source-layout' : undefined}><SourcePanel {...panelProps}/>{!location.path ? <aside className="repository-about" aria-label="About this repository"><h2>About</h2><p>{repository.description || 'No description provided.'}</p><dl><div><dt>Visibility</dt><dd>{repository.private ? 'Private' : 'Public'}</dd></div><div><dt>Default branch</dt><dd><GitBranch size={14}/>{repository.defaultBranch}</dd></div><div><dt>Updated</dt><dd><DateLabel value={repository.updatedAt}/></dd></div></dl><Link className="text-button" {...repositoryOptions(location,{view:'commits',commit:undefined,historyPath:undefined})}><GitCommitHorizontal size={15}/>Commit history</Link></aside> : null}</div> : location.view === 'commits' ? location.commit ? <CommitDiffPanel key={location.commit} {...panelProps} repositoryId={repository.id} /> : <CommitsPanel {...panelProps} /> : location.view === 'actions' ? <Suspense fallback={<Loading label="Opening Actions…"/>}>{location.run ? <WorkflowRunPage key={location.run} userId={userId} owner={location.owner} name={location.name} repositoryId={repository.id} runId={location.run} selectedStep={location.step} signingOut={false}/> : <Actions userId={userId} owner={location.owner} name={location.name} signingOut={false} workView/>}</Suspense> : location.view === 'pulls' ? <Suspense fallback={<Loading label="Opening pull requests…" />}><PullRequestBrowser {...panelProps} repositoryId={repository.id} userId={userId}/></Suspense> : <Suspense fallback={<Loading label="Opening issues…" />}><IssueBrowser key={repository.id} {...panelProps} repositoryId={repository.id} userId={userId} /></Suspense>}
      </>}
    </div></>}
  </div></RepositoryLiveContext>;
}
