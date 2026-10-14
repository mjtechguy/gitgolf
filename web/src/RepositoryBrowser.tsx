import { RepositoryVisibility } from './RepositoryUI';
import { RepositoryFileFinder } from './RepositoryFileFinder';
import { RepositorySettingsLayout } from './AccountSettings';
import type { ReactNode } from 'react';
import { NativePackages, NativePackagesTab } from './NativePackages';
import { RuntimeFeature } from './RuntimeFeature';
import { runtimeFeature } from './runtimeCapabilities';
import { useRepositoryFeatures, policyOff, deciderLabels } from './RepositoryFeatures';
import { NativeRepositoryActions } from './NativeForge';
import { useRuntimeCapabilities } from './useRuntimeCapabilities';
import { RepositorySidebar } from './RepositorySidebar';
import { RepositoryStars } from './RepositoryStars';
import { forgetPrivateQueries } from './queryClient';
import { sourceNavigationOptions, prefetchSource } from './sourceNavigation';
import { sourceRepositoryID } from './sourceReads';
import { useRepositorySourceSelection } from './RepositorySourceSelection';
import { SourceRefChoice } from './SourceRefChoice';
import { RepositoryCommitSummary } from './RepositoryCommitSummary';
import { RepositoryRefs } from './RepositoryRefs';
import { SourceEntryCommit } from './SourceEntryCommit';
import { SourceActions } from './SourceActions';
import { CommitList } from './CommitList';
import { transientRetry } from './nativeAPI';
import { useRepositoryLive, RepositoryLiveStatus, RepositoryLiveContext } from './RepositoryLive';
import { DiffViewer } from './DiffViewer';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppearance } from './ThemeSwitch';
import { finderSlot, SummaryBand, useShellSlot, useWideViewport } from './Layout';
import { openIssues, openPulls, RepositoryOverview } from './RepositoryOverview';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, BookOpen, ChevronRight, ChevronsUpDown, CircleDot, Code2, File, Folder, Package, GitBranch, GitCommitHorizontal, GitPullRequest, Link2, Play, RefreshCw, Settings, Sparkles, Tag } from 'lucide-react';
import { Code, ConnectError } from '@connectrpc/connect';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { repositoryClient, repositoryAccessClient } from './api';
import { CommitDiffBase, SourceEntryType, RepositorySourceRefKind } from './gen/golf/v1/golf_pb';
import type { RepositoryKey, SourceEntry } from './gen/golf/v1/golf_pb';
import { repositoryOptions, sourceOptions } from './navigation';
import type { RepositoryLocation } from './navigation';

import { CopyButton, disclosureDismiss, RepositoryTabs, DateLabel, Loading, More, PanelError, nextPage, privateQuery, privateNavigationQuery, shortSHA } from './RepositoryUI';

const AgentWorkspace = lazy(() => import('./AgentWorkspace').then(m => ({default:m.AgentWorkspace})));
const RepositoryWiki=lazy(()=>import('./RepositoryWiki').then(m=>({default:m.RepositoryWiki})));
const RepositoryReadme=lazy(()=>import('./RepositoryReadme').then(m=>({default:m.RepositoryReadme})));
const CodePreview=lazy(()=>import('./RepositoryContent').then(m=>({default:m.CodePreview})));
const FileContent=lazy(()=>import('./RepositoryContent').then(m=>({default:m.FileContent})));
const RepositoryFileChanges=lazy(()=>import('./RepositoryFileChanges').then(m=>({default:m.RepositoryFileChanges})));
const RepositoryRefManagement=lazy(()=>import('./RepositoryRefManagement').then(m=>({default:m.RepositoryRefManagement})));
const SourceNavigator=lazy(()=>import('./SourceNavigator').then(m=>({default:m.SourceNavigator})));
const RepositoryDeployments=lazy(()=>import('./RepositoryDeployments').then(m=>({default:m.RepositoryDeployments})));
const RepositoryReleases=lazy(()=>import('./RepositoryReleases').then(m=>({default:m.RepositoryReleases})));
const RepositoryCompare = lazy(()=>import('./RepositoryCompare').then(m=>({default:m.RepositoryCompare})));
const IssueBrowser = lazy(() => import('./IssueBrowser').then((module) => ({ default: module.IssueBrowser })));
const PullRequestBrowser = lazy(() => import('./PullRequestBrowser').then((module) => ({ default: module.PullRequestBrowser })));
const ActionRunPage = lazy(() => import('./ActionRunPage').then(m => ({default:m.ActionRunPage})));
const WorkflowRunPage = lazy(() => import('./WorkflowRuns').then(m => ({default:m.WorkflowRunPage})));
const RepositoryPackages = lazy(() => import('./RepositoryPackages').then(module=>({default:module.RepositoryPackages})));
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



function CloneMenu({ https, ssh, native, location }: { https: string; ssh: string; native: boolean; location: RepositoryLocation }) {
  const [protocol, setProtocol] = useState(https ? 'https' : 'ssh');
  const useHTTPS = protocol === 'https' && Boolean(https) || !ssh;
  const address = useHTTPS ? https : ssh;
  return <details className="ref-picker clone-picker" {...disclosureDismiss}><summary><Code2 size={16} aria-hidden="true"/>Code<ChevronRight size={14} aria-hidden="true"/></summary><div className="branch-options clone-options"><strong>Clone this repository</strong><div className="content-view-controls" role="group" aria-label="Clone protocol">{https ? <button type="button" className="text-button" aria-pressed={useHTTPS} onClick={() => setProtocol('https')}>HTTPS</button> : null}{ssh ? <button type="button" className="text-button" aria-pressed={!useHTTPS} onClick={() => setProtocol('ssh')}>SSH</button> : null}</div><div className="copy-field"><input aria-label={`${useHTTPS ? 'HTTPS' : 'SSH'} clone URL`} value={address} readOnly spellCheck={false} onFocus={event => event.currentTarget.select()}/><CopyButton key={address} text={address} label={`Copy ${useHTTPS ? 'HTTPS' : 'SSH'} clone URL`}/></div><p className="field-help">{useHTTPS ? 'Clone using the repository URL.' : 'Clone using an SSH key connected to your account.'}</p>{native ? <Link to="/$owner/$name/settings/git" params={{ owner: location.owner, name: location.name }}>Manage repository Git credentials</Link> : ssh ? <Link to="/account/ssh-keys">Manage SSH keys</Link> : null}</div></details>;
}

function EntryIcon({ type }: { type: SourceEntry['type'] }) {
  const Icon = type === SourceEntryType.DIRECTORY ? Folder : type === SourceEntryType.FILE ? File : type === SourceEntryType.SYMLINK ? Link2 : GitCommitHorizontal;
  return <Icon size={18} aria-hidden="true" />;
}

function useRetainedRepositoryAccess(repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>, queryKey: readonly unknown[], repositoryId: string, contentKey: readonly unknown[]) {
  const cache = useQueryClient();
  const runtime = useRuntimeCapabilities();
  const native = runtime.data?.runtimeProfile === 'cloudflare-native';
  const scope = JSON.stringify(contentKey);
  // Both source providers authorize fresh responses; retained bytes need a new receipt.
  const needsAccess = useMemo(() => cache.getQueryData(contentKey) !== undefined, [cache, native, scope]);
  const access = useQuery({ ...privateQuery, queryKey: [...queryKey, 'source-access', repositoryId, scope, native],
    enabled: needsAccess,
    queryFn: async ({ signal }) => {
      if (native) {
        const response = await repositoryAccessClient.getRepositoryAccess({ repository: repositoryKey }, { signal, timeoutMs: 8000 });
        signal.throwIfAborted();
        if (response.access?.repositoryId !== repositoryId) throw new ConnectError('Repository access identity changed.', Code.PermissionDenied);
        return true;
      }
      const response = await repositoryClient.getRepository({ repository: repositoryKey }, { signal, timeoutMs: 8000 });
      signal.throwIfAborted();
      if (response.repository?.id !== repositoryId || response.repository.fullName.toLowerCase() !== `${repositoryKey.owner}/${repositoryKey.name}`.toLowerCase() || response.repository.name.toLowerCase() !== repositoryKey.name.toLowerCase()) throw new ConnectError('Repository access identity changed.', Code.PermissionDenied);
      return true;
    } });
  return { access, admitted: !needsAccess || access.isSuccess && !access.isError };
}

function SourcePanel({ repositoryKey, queryKey, location, addressLocation, snapshot,repositoryId,onLatest }: { onLatest:()=>void; addressLocation:RepositoryLocation; snapshot:string; repositoryId:string; repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const wide = useWideViewport(), appearance = useAppearance();
  const panes = wide && appearance.feature('tree');
  const finderTarget = useShellSlot('finder');
  const navigate = useNavigate();
  const router = useRouter();
  const cache = useQueryClient();
  // Row changes are private reads, so signed-out visitors start with them hidden.
  const [showLatestChanges, setShowLatestChanges] = useState(() => { const signedIn = queryKey[1] !== 'anonymous'; try { const saved = localStorage.getItem('golf.source.latestChanges'); return saved === 'show' || signedIn && saved !== 'hide'; } catch { return signedIn; } });
  const commitId = snapshot;
  const navigation = sourceNavigationOptions(queryKey, repositoryId, commitId, location.path);
  const { access, admitted } = useRetainedRepositoryAccess(repositoryKey, queryKey, repositoryId, navigation.queryKey);
  // Source RPCs authorize independently; overlap the read with the display gate.
  const query = useInfiniteQuery({ ...navigation,
    enabled: !access.isError, getNextPageParam: nextPage });
  const first = query.data?.pages[0];
  const source = admitted && query.isSuccess && first ? { ...first, entries: query.data.pages.flatMap(page => page.entries) } : undefined;
  // A reader who asked for row changes keeps each row's own state. Otherwise a snapshot that cannot supply any shows plain rows and one note.
  const [asked, setAsked] = useState(() => { try { return localStorage.getItem('golf.source.latestChanges') === 'show'; } catch { return false; } });
  const changesKey = `${repositoryId}:${source?.commitId || ''}:${location.path || ''}`, entryCount = source?.entries?.length || 0;
  const outcomes = useRef({ key: '', available: 0, unavailable: 0 });
  const [unavailableFor, setUnavailableFor] = useState('');
  const rowOutcome = useCallback((available: boolean) => {
    if (asked) return;
    const seen = outcomes.current;
    if (seen.key !== changesKey) Object.assign(seen, { key: changesKey, available: 0, unavailable: 0 });
    if (available) seen.available++; else seen.unavailable++;
    setUnavailableFor(current => !seen.available && seen.unavailable >= Math.min(3, entryCount) ? changesKey : current === changesKey ? '' : current);
  }, [asked, changesKey, entryCount]);
  const changesUnavailable = !asked && unavailableFor === changesKey;
  const withChanges = showLatestChanges && !changesUnavailable;
  useEffect(() => {
    if (!source) return;
    const current = router.state.location;
    if(!addressLocation.sourceRoute) {
      if((current.search.ref||'')!==addressLocation.ref||(current.search.path||'')!==addressLocation.path) return;
      const legacy=current.pathname===`/repositories/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.name)}`;
      if(!legacy&&!addressLocation.ref&&!addressLocation.path) return;
      const target=!addressLocation.ref&&!addressLocation.path?repositoryOptions(location,{ref:'',refKind:undefined,refName:undefined,branch:'',tag:undefined,path:''}):sourceOptions(location,source.commitId,source.path,source.kind!==SourceEntryType.DIRECTORY);
      if(current.pathname!==router.buildLocation(target).pathname) void navigate({...target,hash:current.hash,replace:true});
      return;
    }
    const expected = router.buildLocation(repositoryOptions(location, {}, location.sourceRoute === 'blob' ? 'file' : undefined));
    // Do not let an earlier response normalize another page or selected path.
    if (current.pathname !== expected.pathname) return;
    const file = source.kind !== SourceEntryType.DIRECTORY;
    if ((file ? 'blob' : 'tree') !== location.sourceRoute) void navigate({ ...sourceOptions(location, source.commitId, source.path, file), hash: current.hash, replace: true });
  }, [source, location, addressLocation, navigate, router]);
  if (access.isError) return <PanelError error={access.error} retry={() => void access.refetch()}/>;
  if (!admitted) return <Loading label="Checking repository access…"/>;
  const crumbs = location.path.split('/').filter(Boolean);
  return <div className={location.path||panes?"source-file-layout":undefined}>{(location.path||panes)&&source?<Suspense fallback={<Loading label="Opening file navigation…"/>}><SourceNavigator location={location} commitId={source.commitId} repositoryId={repositoryId} userId={String(queryKey[1]||'')}/></Suspense>:null}<section aria-labelledby="source-title" className="browser-panel">
    <div className="browser-panel-heading source-panel-heading"><h2 id="source-title" className="sr-only">Source</h2>{source?<RepositoryCommitSummary location={location} repositoryId={repositoryId} commitId={source.commitId} userId={String(queryKey[1]||'')}/>:null}{source?<SourceActions location={location} commitId={source.commitId} path={source.path} file={source.kind!==SourceEntryType.DIRECTORY} text={source.file?.entry?.type===SourceEntryType.FILE&&!source.file.previewReason&&source.file.entry.size<=256n*1024n?source.file.content:undefined}/>:null}{source?.kind === SourceEntryType.DIRECTORY && source.entries?.length ? <button type="button" className="text-button latest-changes-toggle" aria-pressed={withChanges} onClick={() => { const next = !withChanges; setShowLatestChanges(next); setAsked(next); try { localStorage.setItem('golf.source.latestChanges', next ? 'show' : 'hide'); } catch {} }}><GitCommitHorizontal size={15}/>{withChanges ? 'Hide latest changes' : 'Show latest changes'}</button> : null}{source ? (finder => appearance.feature('finder') && finderTarget ? createPortal(finder, finderTarget) : finder)(<RepositoryFileFinder key={`${repositoryId}:${source.commitId}`} location={location} repositoryId={repositoryId} commitId={source.commitId} userId={String(queryKey[1]||'')}/>) : null}<button className="icon-button manual-refresh" aria-label="Refresh source" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} className={query.isFetching ? 'spin' : ''} /></button></div>
    {location.path ? <div className="source-path-bar"><nav className="source-breadcrumbs" aria-label="Source path"><Link {...sourceOptions(location, commitId, '')}>{location.name}</Link>{crumbs.map((crumb, index) => <span key={index}><ChevronRight size={13} /><Link {...sourceOptions(location, commitId, crumbs.slice(0, index + 1).join('/'), index === crumbs.length - 1 && source?.kind !== SourceEntryType.DIRECTORY)} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>{crumb}</Link></span>)}</nav></div> : null}
    {source?<RuntimeFeature id="repository.source-write"><Suspense fallback={null}><RepositoryFileChanges location={location} repositoryId={repositoryId} userId={String(queryKey[1]||'')} commitId={source.commitId} path={source.path} directory={source.kind===SourceEntryType.DIRECTORY} blobId={source.file?.entry?.type===SourceEntryType.FILE&&source.file.entry.size<=256n*1024n&&!source.file.previewReason?.includes('LFS')?source.file.entry.sha:undefined} text={source.file?.entry?.type===SourceEntryType.FILE&&!source.file.previewReason?source.file.content:undefined} onComplete={(path,file)=>{onLatest();const branch=location.refKind==='branch'?location.refName:location.branch;if(branch)void navigate(repositoryOptions(location,{view:'source',ref:branch,refKind:'branch',refName:branch,branch,tag:undefined,path},file?'file':undefined));}}/></Suspense></RuntimeFeature>:null}
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !source ? <Loading label="Reading source…" /> : source.kind === SourceEntryType.DIRECTORY ? <>
      {source.entries?.length ? <><ul className={`source-tree ${withChanges ? 'source-tree-with-commits' : changesUnavailable ? 'source-tree-changes-unavailable' : ''}`}>{[...source.entries].sort((a,b)=>Number(b.type===SourceEntryType.DIRECTORY)-Number(a.type===SourceEntryType.DIRECTORY)||a.name.localeCompare(b.name)).map((entry) => <li key={entry.path}><Link title={entry.path} {...sourceOptions(location, commitId, entry.path, entry.type !== SourceEntryType.DIRECTORY)} onPointerEnter={() => prefetchSource(cache, queryKey, repositoryId, commitId, entry)} onFocus={() => prefetchSource(cache, queryKey, repositoryId, commitId, entry)}><EntryIcon type={entry.type} /><span className="source-name">{entry.name}</span><span className="entry-type sr-only">{entryTypeLabel(entry.type)}</span>{entry.type !== SourceEntryType.DIRECTORY ? <Size value={entry.size} className="sr-only" /> : <span className="sr-only" /> }<ChevronRight size={14} /></Link>{showLatestChanges ? <SourceEntryCommit userId={String(queryKey[1]||'')} repositoryId={repositoryId} commitId={source.commitId} path={entry.path} location={location} latestChange={entry.latestChange} onOutcome={rowOutcome}/> : null}</li>)}</ul></> : <div className="empty-state"><Folder size={25} /><h3>This directory is empty.</h3></div>}
      <More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="files"/>
      <p className="panel-footnote">{source.entries?.length || 0}{source.totalEntries ? ` of ${source.totalEntries}` : ''} entries · Read-only snapshot at <code>{shortSHA(source.commitId)}</code>{changesUnavailable ? ' · Latest changes are unavailable for this snapshot' : ''}</p>
      <Suspense fallback={<Loading label="Opening README…"/>}><RepositoryReadme repositoryId={repositoryId} owner={repositoryKey.owner} name={repositoryKey.name} refId={source.commitId} path={location.path} entries={source.entries} location={location} userId={String(queryKey[1]||'')}/></Suspense>
    </> : source.file?.entry ? <>
      <div className="file-meta"><span><EntryIcon type={source.file.entry.type} />{entryTypeLabel(source.file.entry.type).toLowerCase()}</span><Size value={source.file.entry.size} /><span>Object <code title={source.file.entry.sha}>{shortSHA(source.file.entry.sha)}</code></span></div>
      {source.file.entry.type === SourceEntryType.FILE && source.file.content !== undefined && !source.file.previewReason && source.file.entry.size <= 256n * 1024n ? <Suspense fallback={<Loading label="Opening preview…"/>}>{/\.(md|markdown|mdown)$/i.test(source.file.entry.name) ? <FileContent key={source.file.entry.sha} text={source.file.content} path={source.file.entry.path} context={{repositoryId,owner:repositoryKey.owner,name:repositoryKey.name,ref:source.commitId,path:source.file.entry.path,userId:String(queryKey[1]),sourceAddress:location.refKind?{kind:location.refKind,name:location.refName!}:undefined}}/> : <CodePreview text={source.file.content} path={source.file.entry.name} label={`Plain text preview of ${source.file.entry.name}`}/>}</Suspense> : <div className="preview-unavailable"><File size={26} /><h3>Preview unavailable</h3><p>{source.file.previewReason || 'This file is outside the supported plain-text preview limits.'}</p><p className="muted">Previews support UTF-8 text up to 256 KiB. Binary, large, LFS, symlink and submodule content is not opened.</p></div>}
      <p className="panel-footnote">Rendered Markdown or highlighted source · Read-only snapshot at <code>{shortSHA(source.commitId)}</code></p>
    </> : <p className="error" role="alert">The source response did not contain file metadata.</p>}
  </section></div>;
}

function CommitsPanel({ repositoryKey, queryKey, location, defaultBranch,repositoryId }: { repositoryId:string; repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; queryKey: readonly unknown[]; location: RepositoryLocation; defaultBranch: string }) {
  const navigate = useNavigate();
  const ref = location.ref || defaultBranch;
  const historyKey = [...queryKey, 'commits', ref, location.historyPath || '', repositoryId];
  const { access, admitted } = useRetainedRepositoryAccess(repositoryKey, queryKey, repositoryId, historyKey);
  const query = useInfiniteQuery({ ...(location.historyPath && isCommit(ref) ? privateNavigationQuery : privateQuery), queryKey: historyKey, enabled: !access.isError, initialPageParam: 1,
    queryFn: async({ pageParam, signal }) => {const path=location.historyPath||'';const response=await repositoryClient.listCommits({ repository: repositoryKey, ref,path,repositoryId: isCommit(ref) ? repositoryId : '', page: { page: pageParam } }, { signal });if(path&&(response.path!==path||response.commitId!==ref||response.repositoryId!==repositoryId))throw new ConnectError('The returned history does not match this path and snapshot.',Code.FailedPrecondition);return response;}, getNextPageParam: nextPage });
  const commits = admitted && query.isSuccess && (!query.isFetching || query.isFetchingNextPage) ? [...new Map(query.data.pages.flatMap((page) => page.commits).map((commit) => [commit.sha, commit])).values()] : [];
  const head = commits[0]?.sha;
  useEffect(() => {
    if (head && !isCommit(location.ref)) void navigate({ ...repositoryOptions(location, { ref: head, branch: location.branch || location.ref || defaultBranch }), replace: true });
  }, [head, location, defaultBranch, navigate]);
  if (access.isError) return <PanelError error={access.error} retry={() => void access.refetch()}/>;
  if (!admitted) return <Loading label="Checking repository access…"/>;
  return <section aria-labelledby="commits-title" className="browser-panel commit-history">
    <div className="browser-panel-heading"><h2 id="commits-title">Commit history</h2><button className="icon-button manual-refresh" aria-label="Refresh commits" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} /></button></div>{location.historyPath?<div className="source-history-heading"><Link className="text-button" {...repositoryOptions(location,{view:'source',ref,path:location.historyPath,historyPath:undefined})}><ArrowLeft size={15}/>Back to source</Link><code>{location.historyPath}</code><span className="muted">History for this literal path; earlier names are not followed.</span></div>:null}
    {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : query.isPending || (query.isFetching && !query.isFetchingNextPage) ? <Loading label="Loading commits…" /> : <>
      <CommitList commits={commits} location={location}/>
      {!commits.length ? <div className="empty-state"><GitCommitHorizontal size={25} /><h3>No commits at this ref.</h3></div> : null}
      <div className="list-footer"><span>{commits.length} loaded commits{query.hasNextPage ? ' · More available' : ''}</span><More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label="commits" /></div>
    </>}
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
        <div className="commit-diff-metadata"><h3>{diff.commit!.message.split('\n')[0] || 'Untitled commit'}</h3><p>{diff.commit!.authorName || 'Unknown author'} · <DateLabel value={diff.commit!.authoredAt}/> · <code>{shortSHA(diff.commit!.sha)}</code></p><details className="metadata-details" open={diff.base === CommitDiffBase.ROOT || diff.parentCommitIds.length > 1}><summary>Commit details</summary><dl><div><dt>Commit</dt><dd><code>{diff.commit!.sha}</code></dd></div><div><dt>Comparison</dt><dd>{diff.base === CommitDiffBase.ROOT ? 'Root commit · no parent' : 'First parent'}{diff.baseCommitId ? <code>{diff.baseCommitId}</code> : null}</dd></div><div><dt>Parents</dt><dd>{diff.parentCommitIds.length ? diff.parentCommitIds.map((id) => <code key={id}>{id}</code>) : 'None'}</dd></div><div><dt>Author</dt><dd>{diff.commit!.authorName || 'Unknown author'} · <DateLabel value={diff.commit!.authoredAt} /></dd></div><div><dt>Patch size</dt><dd>{diff.byteSize.toLocaleString()} bytes</dd></div></dl>
          <pre className="commit-diff-message" tabIndex={0} aria-label="Commit message, plain text">{diff.commit!.message || '(No commit message)'}</pre>
          {diff.parentCommitIds.length > 1 ? <p>Merge commit: only the first-parent comparison is shown.</p> : null}
          {diff.base === CommitDiffBase.ROOT ? <p>Root output may include Git’s commit header before the patch.</p> : null}
          <p>Text diffs are limited to 512 KiB. Binary files show metadata instead of a text preview.</p>
        </details></div>
        {diff.rawDiff ? <DiffViewer key={`${String(queryKey[1])}-${repositoryId}-${commitId}`} text={diff.rawDiff} snapshotId={commitId}/> : <div className="empty-state"><GitCommitHorizontal size={25} /><h3>No diff text returned</h3><p>The provider returned empty output for this commit.</p></div>}
      </>}
    </section>
  </>;
}

// Open items for a repository tab, from the same bounded read the overview uses; "50+" when another page exists.
function TabCount({ kind, repository, userId }: { kind: 'issues' | 'pulls'; repository: Pick<RepositoryKey, 'owner' | 'name'>; userId: string }) {
  const pulls = useQuery({ ...openPulls(userId, repository), enabled: kind === 'pulls' }), issues = useQuery({ ...openIssues(userId, repository), enabled: kind === 'issues' });
  const count = kind === 'pulls' ? pulls.data?.items.length : issues.data?.count, next = kind === 'pulls' ? pulls.data?.more : issues.data?.more;
  return count ? <span className="tab-count">{count}{next ? '+' : ''}<span className="sr-only"> open</span></span> : null;
}

export function RepositoryBrowser({ location: addressLocation, userId, anonymous = false, settingsPage = false, children }: { location: RepositoryLocation; userId: string; anonymous?: boolean; settingsPage?: boolean; children?: ReactNode }) {
  const runtime = useRuntimeCapabilities();
  const native = runtime.data?.runtimeProfile === 'cloudflare-native';
  // Semantic search answers while degraded too: that state only says no index has read back from Vectorize yet.
  const searchOffered = runtime.data?.capabilities.some(item => item.id === 'repository.semantic-search' && (item.state === 3 || item.state === 4));
  const cache = useQueryClient();
  const appearance = useAppearance();
  const navigationSlot = useShellSlot('navigation'), topSlot = useShellSlot('heading'), tabsTarget = useShellSlot('tabs'), toolsTarget = useShellSlot('tools');
  const wide = useWideViewport();
  const repositoryKey = { owner: addressLocation.owner, name: addressLocation.name };
  const queryKey = ['repository', userId, addressLocation.owner, addressLocation.name];
  const query = useQuery({ ...privateQuery, ...transientRetry, enabled: !settingsPage, queryKey: [...queryKey, 'metadata'], queryFn: ({ signal }) => repositoryClient.getRepository({ repository: repositoryKey }, { signal }).then((response) => { signal.throwIfAborted(); if (!response.repository) throw new ConnectError('The repository response is missing its metadata.', Code.Internal); if(addressLocation.view==='wiki'&&(!sourceRepositoryID(response.repository.id)||response.repository.name!==repositoryKey.name||response.repository.fullName!==`${repositoryKey.owner}/${repositoryKey.name}`))throw new ConnectError('The repository response does not identify the selected wiki target.',Code.Internal); if(['releases','deployments','packages'].includes(addressLocation.view) && (!sourceRepositoryID(response.repository.id) || response.repository.name!==repositoryKey.name || response.repository.fullName!==`${repositoryKey.owner}/${repositoryKey.name}`)) throw new ConnectError('The repository response does not identify the selected repository target.', Code.Internal); if(response.sourceSelection && (response.sourceSelection.kind !== RepositorySourceRefKind.DEFAULT_BRANCH || response.sourceSelection.name !== response.repository.defaultBranch || !isCommit(response.sourceSelection.commitId) || response.sourceSelection.tagObjectId !== undefined)) throw new ConnectError('The default source observation does not match this repository.', Code.FailedPrecondition); return { ...response.repository, defaultSource: response.sourceSelection }; }) });
  const sourceSelection = useRepositorySourceSelection(addressLocation, query.data?.id || '', userId, !settingsPage && addressLocation.view === 'source' && query.isSuccess && !query.isError && !query.data.empty, query.data?.defaultSource);
  const location = sourceSelection.location;
  const live=useRepositoryLive(userId,location.owner,location.name,query.data?.id,sourceSelection.selection?.commitId||location.ref,query.isSuccess&&!query.isError&&!anonymous,location.view==='compare'||location.view==='pulls'&&Boolean(location.pull)&&location.pullView!==undefined&&location.pullView!=='conversation',runtimeFeature(runtime.data,'repository.live'));
  const repository = query.isSuccess ? query.data : undefined;
  const [explicitAccessCheck, setExplicitAccessCheck] = useState(false);
  // Only an explicit access check blanks the page; background revalidation (focus, live events) keeps what is shown until it answers.
  const suspendAccess = query.isFetching && explicitAccessCheck;
  async function refreshAccess() { setExplicitAccessCheck(true); try { await query.refetch(); } finally { setExplicitAccessCheck(false); } }
  const denyStarAuthority = useCallback(async (error: ConnectError) => {
    const key = ['repository', userId, addressLocation.owner, addressLocation.name, 'metadata'];
    const matches = () => repository?.id && cache.getQueryData(key) === repository;
    if (!matches()) return;
    if (error.code === Code.Unauthenticated) { cache.setQueryData(['session'], null); forgetPrivateQueries(cache); return; }
    const scope = ['repository', userId, addressLocation.owner, addressLocation.name];
    await cache.cancelQueries({queryKey:scope});
    if (!matches()) return;
    cache.removeQueries({predicate:q => q.queryKey.length > key.length && scope.every((value,index) => q.queryKey[index] === value)});
    cache.getQueryCache().find({queryKey:key,exact:true})?.setState({data:undefined,error,status:'error',fetchStatus:'idle'});
  }, [cache, userId, addressLocation.owner, addressLocation.name, repository]);
  const features = useRepositoryFeatures(anonymous ? '' : userId, addressLocation.owner, addressLocation.name).data?.features;
  // Pages of a feature a policy turned off say which level decided, in place of the page.
  // The Agent workspace serves Cloudflare agent proposals and tasks on agent hosts; it closes only when both are off.
  const agentsOff = policyOff(features, 'agents') && policyOff(features, 'agent-hosts');
  const blockedFeature = settingsPage ? undefined : location.view === 'agents' ? agentsOff || undefined : policyOff(features, ({ actions: 'actions', releases: 'releases', packages: 'packages', issues: 'issues', pulls: 'pull-requests', compare: 'pull-requests' } as Record<string, string>)[location.view] || '');
  const disabledFeature = location.view==='wiki'&&repository?.wikiEnabled===false?'Wiki':location.view === 'issues' && repository?.issuesEnabled === false ? 'Issues' : (location.view === 'pulls' || location.view === 'compare') && repository?.pullRequestsEnabled === false ? 'Pull requests' : '';
  const panelProps = { repositoryKey, queryKey, location, defaultBranch: repository?.defaultBranch || '',repositoryId:repository?.id||'' };
  const codeToolbar = <div className="repository-code-toolbar"><RepositoryRefs {...panelProps} onLatest={location.view === 'source' ? sourceSelection.latest : undefined} latestPending={sourceSelection.pending} pinnedCommitId={sourceSelection.selection?.commitId} unresolvedSource={!sourceSelection.selection&&Boolean(addressLocation.sourceSuffix)}/><span ref={finderSlot} className="toolbar-finder" />{location.view === 'source' && (repository?.cloneUrl || repository?.sshUrl) ? <CloneMenu https={repository.cloneUrl} ssh={repository.sshUrl} native={native&&!anonymous} location={location}/> : null}</div>;
  const emptyState = <section className="browser-panel empty-state"><GitBranch size={29} /><h2>No commits yet.</h2><p>This repository is empty. Push your first commit through Git to add source and branches.</p>{repository?.cloneUrl ? <div className="clone-address"><span>HTTPS clone URL</span><code>{repository?.cloneUrl}</code></div> : null}{repository?.sshUrl ? <div className="clone-address"><span>SSH clone URL</span><code>{repository?.sshUrl}</code></div> : null}</section>;
  const counts = appearance.feature('counts') && !anonymous && Boolean(repository);
  const tabs = <RepositoryTabs label="Repository" selection={settingsPage?'settings':location.view==='branches'||location.view==='tags'?'source':location.view}><Link data-shortcut="c" {...repositoryOptions(location, { view: 'source', issue: undefined })} aria-current={!settingsPage && (location.view === 'source'||location.view==='branches'||location.view==='tags') ? 'page' : undefined}><Code2 size={16} />Code</Link><Link data-shortcut="m" {...repositoryOptions(location, { view: 'commits', ref:sourceSelection.selection?.commitId||location.ref, issue: undefined, commit: undefined,historyPath:undefined })} aria-current={!settingsPage && location.view === 'commits' ? 'page' : undefined}><GitCommitHorizontal size={17} />Commits</Link>{!anonymous && <>{repository?.issuesEnabled !== false ? <Link data-shortcut="i" {...repositoryOptions(location, { view: 'issues', issue: undefined,issueNew:undefined })} aria-current={!settingsPage && location.view === 'issues' ? 'page' : undefined}><CircleDot size={16} />Issues{counts ? <TabCount kind="issues" repository={repositoryKey} userId={userId} /> : null}</Link> : null}{repository?.pullRequestsEnabled !== false ? <Link data-shortcut="p" {...repositoryOptions(location, { view: 'pulls', pull: undefined })} aria-current={!settingsPage && (location.view === 'pulls' || location.view === 'compare') ? 'page' : undefined}><GitPullRequest size={16} />Pull requests{counts ? <TabCount kind="pulls" repository={repositoryKey} userId={userId} /> : null}</Link> : null}{!policyOff(features, 'actions') && <Link data-shortcut="a" {...repositoryOptions(location, { view: 'actions',run:undefined })} aria-current={!settingsPage && location.view === 'actions' ? 'page' : undefined}><Play size={16}/>Actions</Link>}{native && !agentsOff && <Link data-shortcut="b" {...repositoryOptions(location, {view: 'agents', pull: undefined})} aria-current={!settingsPage && location.view === 'agents' ? 'page' : undefined}><Bot size={16}/>Agent workspace</Link>}<RuntimeFeature id="repository.releases">{policyOff(features, 'releases') ? null : <Link data-shortcut="l" {...repositoryOptions(location,{view:'releases',releaseId:undefined})} aria-current={!settingsPage && location.view==='releases'?'page':undefined}><Tag size={16}/>Releases</Link>}</RuntimeFeature>{runtimeFeature(runtime.data, 'repository.wiki') && repository?.wikiEnabled!==false?<Link data-shortcut="w" {...repositoryOptions(location,{view:'wiki',wikiPage:undefined})} aria-current={!settingsPage && location.view==='wiki'?'page':undefined}><BookOpen size={16}/>Wiki</Link>:null}<RuntimeFeature id="repository.packages">{policyOff(features, 'packages') ? null : native ? <NativePackagesTab selected={!settingsPage && location.view === 'packages'} userId={userId} repository={repositoryKey} repositoryId={repository?.id||''} blocked={!repository}/> : <Link data-shortcut="k" {...repositoryOptions(location,{view:'packages'})} aria-current={!settingsPage && location.view==='packages'?'page':undefined}><Package size={16}/>Packages</Link>}</RuntimeFeature><Link data-shortcut="s" aria-current={settingsPage?'page':undefined} to="/$owner/$name/settings" params={{owner:location.owner,name:location.name}}><Settings size={16}/>Settings</Link></>}</RepositoryTabs>;
  const sideNavigation = appearance.feature('contextnav') && wide && navigationSlot;
  const crumb = appearance.feature('crumb') && wide && topSlot;
  const headingSlot = !crumb && appearance.nav !== 'top' && wide && topSlot;
  const headerTabs = appearance.feature('headertabs') && wide && tabsTarget;
  const topTools = appearance.feature('toptools') && wide && toolsTarget;
  const toolbar = topTools ? createPortal(codeToolbar, topTools) : codeToolbar;
  const owner = native && document.documentElement.dataset.golfPublic === 'true' ? <Link to="/$owner" params={{owner:location.owner}}>{location.owner}</Link> : <span>{location.owner}</span>;
  const root = !settingsPage && location.view === 'source' && !location.path;
  // One compact row in every layout: search is a link to the search page, so the group never wraps into the bar or under the title.
  const repositoryActions = () => !settingsPage && repository ? <div className="panel-actions repository-identity-actions"><RepositoryVisibility isPrivate={repository.private} />{!anonymous && <>{native && searchOffered && !policyOff(features, 'semantic-search') ? <Link className="icon-button repository-search-link" to="/$owner/$name/search" params={{ owner: location.owner, name: location.name }} aria-label="Search this repository by meaning" title="Search this repository by meaning"><Sparkles size={16} aria-hidden="true"/></Link> : null}<RepositoryStars client={repositoryClient} userId={userId} repository={repositoryKey} repositoryId={repository.id} revalidating={query.isFetching} onAuthorityDenied={denyStarAuthority}/><RepositoryLiveStatus status={live.status} reconnect={live.reconnect}/></>}<button className="icon-button manual-refresh" aria-label="Refresh repository access" disabled={query.isFetching} onClick={() => void refreshAccess()}><RefreshCw size={16} /></button></div> : null;
  const identityActions = repositoryActions();
  // Layouts with a top-bar breadcrumb show the title row on the repository root only; the repository controls always sit beside the breadcrumb, so they never move between pages.
  const compact = Boolean(crumb) && !root;
  const identity = <div className={`repository-identity ${compact ? 'repository-identity-compact' : ''}`}><h1 className="repository-context" aria-label={`${location.owner}/${location.name}`} title={`${location.owner}/${location.name}`}>{topTools ? <><Link className="repository-context-root" to="/">Repositories</Link><span aria-hidden="true">/</span></> : null}{owner}<span aria-hidden="true">/</span><Link {...repositoryOptions({owner:location.owner,name:location.name})}>{location.name}</Link></h1>{crumb ? null : identityActions}</div>;
  return <RepositoryLiveContext value={live.status}><div className={`repository-browser ${live.status==='live'?'live-connected':''}`}>
    {crumb ? createPortal(<nav className="context-crumb" aria-label="Repository path">{owner}<span aria-hidden="true">/</span><Link {...repositoryOptions({owner:location.owner,name:location.name})}>{location.name}</Link>{appearance.feature('pagehead') ? <button type="button" className="context-crumb-switch" aria-label="Switch repository" title="Switch repository" onClick={() => window.dispatchEvent(new Event('golf-jump'))}><ChevronsUpDown size={13} aria-hidden="true" /></button> : null}{appearance.feature('pagehead') && repository ? <><RepositoryVisibility isPrivate={repository.private} /><span aria-hidden="true">/</span><Link className="context-crumb-ref" {...repositoryOptions(location, { view: 'branches' })}><GitBranch size={14} aria-hidden="true" />{location.refName || repository.defaultBranch || 'Branches'}</Link></> : null}{identityActions}</nav>, crumb) : null}
    {headingSlot ? createPortal(identity, headingSlot) : identity}
    {appearance.feature('pagehead') && repository?.description && root ? <p className="repository-identity-description">{repository.description}</p> : null}
    {!query.isError || settingsPage ? sideNavigation ? createPortal(<><span className="appearance-sidebar-label">{location.owner}/{location.name}</span>{tabs}</>, sideNavigation) : headerTabs ? createPortal(tabs, headerTabs) : <div className="repository-navigation">{tabs}</div> : null}
    {appearance.feature('band') && repository && !settingsPage ? <SummaryBand label="Repository summary" items={[['Visibility', repository.private ? 'Private' : 'Public'], ['Default branch', repository.defaultBranch || 'Not set'], ['Issues', repository.issuesEnabled === undefined ? 'Not reported' : repository.issuesEnabled ? 'Enabled' : 'Off'], ['Pull requests', repository.pullRequestsEnabled === undefined ? 'Not reported' : repository.pullRequestsEnabled ? 'Enabled' : 'Off'], ['Updated', repository.updatedAt ? <DateLabel value={repository.updatedAt}/> : 'Not reported']]} /> : null}
    {settingsPage ? <RepositorySettingsLayout owner={location.owner} name={location.name} userId={anonymous ? '' : userId}>{children}</RepositorySettingsLayout> : query.isError ? <PanelError error={query.error} retry={() => void query.refetch()} /> : !repository ? <Loading label="Opening repository…" /> : <>{suspendAccess ? <div className="repository-access-check"><Loading label="Checking repository access…"/></div> : null}<div className="repository-authorized-content" data-revalidating={suspendAccess || undefined} aria-hidden={suspendAccess || undefined} inert={suspendAccess}>
      {live.newSource && location.view!=='packages'&&location.view!=='wiki'&&location.view!=='releases'&&location.view!=='deployments'?<p className="source-update-notice" role="status"><GitCommitHorizontal size={15}/>{location.view==='compare'||location.view==='pulls'&&Boolean(location.pull)&&location.pullView!==undefined&&location.pullView!=='conversation'?<>Repository activity changed. This comparison stays pinned.<button className="text-button" onClick={live.refreshComparison}>Refresh comparison</button></>:<>New repository activity is available. This source snapshot stays pinned; choose Latest {location.refKind==='tag'?'tag version':'branch head'} to view new code.</>}</p>:null}
      {blockedFeature ? <section className="browser-panel empty-state feature-policy-blocked" aria-labelledby="feature-policy-blocked-title"><Settings size={25}/><h2 id="feature-policy-blocked-title">{blockedFeature.label} turned off</h2><p className="feature-unavailable-state">{deciderLabels[blockedFeature.decidedBy]}</p><p>{blockedFeature.reason} Nothing was deleted; turning it back on restores this page.</p><div className="credential-actions"><Link className="button secondary" {...repositoryOptions(location, { view: 'source' })}>Back to code</Link><Link className="button secondary" to="/$owner/$name/settings" params={{ owner: location.owner, name: location.name }}>See repository features</Link></div></section> : (['releases','packages','wiki'].includes(location.view) && !runtimeFeature(runtime.data, 'repository.'+location.view)) ? <section className="browser-panel empty-state"><h2>This feature is unavailable on this installation</h2><Link className="button secondary" to="/status">View capabilities</Link></section> : disabledFeature ? <section className="browser-panel empty-state"><Settings size={25}/><h2>{disabledFeature} are disabled</h2><p>This repository has this feature turned off.</p><Link className="button secondary" {...repositoryOptions(location, { view: 'source' })}>Back to code</Link></section> : (location.view === 'source' || location.view === 'commits') && repository.empty ? location.view === 'source' && !location.path ? <div className="repository-source-layout"><div className="repository-source-main">{emptyState}</div><RepositorySidebar key={`${userId}-${repository.id}`} repository={repository} location={location} userId={userId}/></div> : emptyState : <>
        {location.view === 'source' && sourceSelection.selection && location.path || location.view === 'commits' && !location.commit && !location.historyPath ? toolbar : null}
        {location.view==='agents'?native?<Suspense fallback={<Loading label="Opening agent workspace…"/>}><AgentWorkspace key={`${userId}-${repository.id}`} location={location} repositoryId={repository.id} userId={userId}/></Suspense>:<p>Agent workspace is available on the native runtime. Use Actions for this installation’s agent tasks.</p>:location.view==='packages'&&native?<RuntimeFeature id="repository.packages"><NativePackages packageDigest={location.packageDigest} packagePanel={location.packagePanel} userId={userId} repository={repositoryKey} repositoryId={repository.id} blocked={query.isFetching}/></RuntimeFeature>:location.view==='packages'?<Suspense fallback={<Loading label="Opening packages…"/>}><RepositoryPackages userId={userId} repository={repositoryKey} repositoryId={repository.id} blocked={query.isFetching}/></Suspense>:location.view==='wiki'?<Suspense fallback={<Loading label="Opening wiki…"/>}><RepositoryWiki location={location} repositoryId={repository.id} userId={userId} blocked={query.isFetching}/></Suspense>:location.view==='branches'||location.view==='tags'?<Suspense fallback={<Loading label="Opening repository refs…"/>}><RepositoryRefManagement location={location} repositoryId={repository.id} userId={userId} defaultBranch={repository.defaultBranch} blocked={query.isFetching}/></Suspense>:location.view==='deployments'?<Suspense fallback={<Loading label="Opening deployments…"/>}><RepositoryDeployments userId={userId} repository={repositoryKey} repositoryId={repository.id} deploymentId={location.deploymentId} onAuthorityDenied={denyStarAuthority} signingOut={false} revalidating={query.isFetching}/></Suspense>:location.view==='releases'?<Suspense fallback={<Loading label="Opening releases…"/>}><RepositoryReleases client={repositoryClient} userId={userId} signingOut={false} repository={repositoryKey} repositoryId={repository.id} releaseId={location.releaseId} revalidating={query.isFetching}/></Suspense>:location.view==='compare'?<Suspense fallback={<Loading label="Opening comparison…"/>}><RepositoryCompare key={repository.id} {...panelProps} repository={repository} userId={userId}/></Suspense>:location.view === 'source' ? !sourceSelection.selection ? <><div className="repository-source-main">{toolbar}</div><SourceRefChoice location={addressLocation} candidates={sourceSelection.candidates} error={sourceSelection.error} pending={sourceSelection.pending} retry={sourceSelection.latest}/></> : location.path ? <SourcePanel {...panelProps} onLatest={sourceSelection.latest} addressLocation={addressLocation} snapshot={sourceSelection.selection.commitId}/> : <>{appearance.feature('overview') && !anonymous ? <RepositoryOverview location={location} repository={repositoryKey} repositoryId={repository.id} commitId={sourceSelection.selection!.commitId} defaultBranch={repository.defaultBranch} userId={userId} /> : null}<div className="repository-source-layout"><div className="repository-source-main">{toolbar}<SourcePanel {...panelProps} onLatest={sourceSelection.latest} addressLocation={addressLocation} snapshot={sourceSelection.selection!.commitId}/></div><RepositorySidebar key={`${userId}-${repository.id}`} repository={repository} location={location} userId={userId} commitId={sourceSelection.selection?.commitId}/></div></> : location.view === 'commits' ? location.commit ? <CommitDiffPanel key={location.commit} {...panelProps} repositoryId={repository.id} /> : <CommitsPanel {...panelProps} /> : location.view === 'actions' && native ? <NativeRepositoryActions key={`${userId}-${repository.id}`} context={{repository:repositoryKey,repositoryId:repository.id}} userId={userId} runId={location.run} workflowPath={location.workflowPath}/> : location.view === 'actions' ? <Suspense fallback={<Loading label="Opening Actions…"/>}>{location.run ? location.runKind==='coding-task'||location.runKind==='review' ? <ActionRunPage key={`${userId}-${location.runKind}-${location.run}`} userId={userId} repositoryId={repository.id} location={location} signingOut={false}/> : <WorkflowRunPage key={location.run} location={location} userId={userId} owner={location.owner} name={location.name} repositoryId={repository.id} runId={location.run} selectedStep={location.step} selectedJobInstanceId={location.jobInstanceId} selectedStepId={location.stepId} signingOut={false}/> : <Actions userId={userId} owner={location.owner} name={location.name} repositoryId={repository.id} signingOut={false} workView location={location}/>}</Suspense> : location.view === 'pulls' ? <Suspense fallback={<Loading label="Opening pull requests…" />}><PullRequestBrowser {...panelProps} repositoryId={repository.id} userId={userId}/></Suspense> : <Suspense fallback={<Loading label="Opening issues…" />}><IssueBrowser key={repository.id} {...panelProps} repositoryId={repository.id} userId={userId} /></Suspense>}
      </>}
    </div></>}
  </div></RepositoryLiveContext>;
}
