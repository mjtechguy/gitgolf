import { useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, GitBranch, LockKeyhole, RefreshCw, ShieldCheck, Tag } from 'lucide-react';
import { Code, ConnectError } from '@connectrpc/connect';
import { repositoryClient } from './api';
import { isCommitID, repositoryOptions } from './navigation';
import type { RepositoryLocation } from './navigation';
import type { RepositoryKey } from './gen/golf/v1/golf_pb';
import { disclosureDismiss, Loading, More, nextPage, PanelError, privateQuery, shortSHA } from './RepositoryUI';

export function RepositoryRefs({ repositoryKey, repositoryId, queryKey, location, defaultBranch, onLatest, latestPending, pinnedCommitId, unresolvedSource }: {
  repositoryKey: Pick<RepositoryKey, 'owner' | 'name'>; repositoryId: string; queryKey: readonly unknown[];
  location: RepositoryLocation; defaultBranch: string; onLatest?: () => void; latestPending?: boolean; pinnedCommitId?: string; unresolvedSource?:boolean;
}) {
  const navigate = useNavigate(), details = useRef<HTMLDetailsElement>(null);
  const [search, setSearch] = useState(''), [kind, setKind] = useState<'branches' | 'tags'>('branches');
  const [tagsRequested, setTagsRequested] = useState(false);
  const branchesQuery = useInfiniteQuery({ ...privateQuery, queryKey: [...queryKey, 'branches', repositoryId], initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => repositoryClient.listBranches({ repository: repositoryKey, repositoryId, page: { page: pageParam } }, { signal }), getNextPageParam: nextPage });
  const tagsQuery = useInfiniteQuery({ ...privateQuery, retry: false, queryKey: [...queryKey, 'tags', repositoryId], initialPageParam: 1, enabled: tagsRequested,
    queryFn: async ({ pageParam, signal }) => {
      const response = await repositoryClient.listTags({ repository: repositoryKey, repositoryId, page: { page: pageParam } }, { signal });
      if (response.repositoryId !== repositoryId || response.tags.some(tag => !isCommitID(tag.commitId))) throw new ConnectError('The tags do not match this repository.', Code.FailedPrecondition);
      return response;
    }, getNextPageParam: nextPage });
  const query = kind === 'branches' ? branchesQuery : tagsQuery;
  const branches = [...new Map(branchesQuery.data?.pages.flatMap(page => page.branches).map(branch => [branch.name, branch])).values()];
  const tags = [...new Map(tagsQuery.data?.pages.flatMap(page => page.tags).map(tag => [tag.name, tag])).values()];
  const branchName = location.tag ? '' : location.branch || (!location.ref ? defaultBranch : '');
  const open = (selection: 'branches' | 'tags') => { setKind(selection); setSearch(''); if (selection === 'tags') setTagsRequested(true); if (details.current) { details.current.open = true; details.current.querySelector('summary')?.focus(); } };
  const count = (inventory: typeof branchesQuery.data | typeof tagsQuery.data) => {
    const page = inventory?.pages[0];
    return page?.repositoryId === repositoryId && page.totalCount !== undefined && /^(0|[1-9][0-9]*)$/.test(page.totalCount) ? `${page.totalCount} ` : '';
  };
  const matches = (name: string) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const latest=()=>{
    if(onLatest&&!location.refKind&&isCommitID(location.ref)&&(branchName||location.tag)) {
      const kind=location.tag?'tag':'branch',name=location.tag||branchName;
      void navigate(repositoryOptions(location,{ref:name,refKind:kind,refName:name,branch:kind==='branch'?name:'',tag:kind==='tag'?name:undefined}));
    } else onLatest?.();
  };
  const close = () => { if (details.current) details.current.open = false; };
  const choose=(kind:'branch'|'tag',name:string)=>{if(location.refKind===kind&&location.refName===name)onLatest?.();close();};
  return <div className="ref-controls">
    <details className="ref-picker branch-picker" ref={details} {...disclosureDismiss} onToggle={event => { if (!event.currentTarget.open) setSearch(''); }}>
      <summary>{location.tag ? <Tag size={16}/> : <GitBranch size={16}/>}<span>{unresolvedSource?'Choose ref':location.tag || branchName || (isCommitID(location.ref) ? 'Selected commit' : location.ref) || defaultBranch}</span><ChevronRight size={14}/></summary>
      <div className="branch-options">
        <div className="content-view-controls" role="group" aria-label="Repository refs"><button type="button" className="text-button" aria-pressed={kind === 'branches'} onClick={() => open('branches')}>Branches</button><button type="button" className="text-button" aria-pressed={kind === 'tags'} onClick={() => open('tags')}>Tags</button></div>
        <strong>Choose a {kind === 'branches' ? 'branch' : 'tag'}</strong>
        <input className="branch-search" type="search" aria-label={`Search loaded ${kind}`} placeholder={`Search loaded ${kind}…`} autoComplete="off" value={search} onChange={event => setSearch(event.target.value)}/>
        <p className="field-help">Search covers loaded {kind}. Selection resolves the current named ref; listed commits are observations.</p>
        {query.isError ? <PanelError error={query.error} retry={() => void query.refetch()}/> : query.isPending || query.isFetching && !query.isFetchingNextPage ? <Loading label={`Loading ${kind}…`}/> : <>
          <ul>{kind === 'branches' ? branches.filter(branch => matches(branch.name)).map(branch => <li key={branch.name}><Link {...repositoryOptions(location, { ref: branch.name, refKind: location.view === 'source' ? 'branch' : undefined, refName: location.view === 'source' ? branch.name : undefined, branch: branch.name, tag: undefined, path: '', historyPath: undefined })} onClick={()=>choose('branch',branch.name)}><GitBranch size={15}/><span>{branch.name}<small>Listed at {shortSHA(branch.commitId)}</small></span>{branch.protected ? <ShieldCheck size={15} aria-label="Protected branch"/> : null}</Link></li>) : tags.filter(tag => matches(tag.name)).map(tag => <li key={tag.name}><Link {...repositoryOptions(location, { ref: location.view === 'source' ? tag.name : tag.commitId, refKind: location.view === 'source' ? 'tag' : undefined, refName: location.view === 'source' ? tag.name : undefined, branch: '', tag: tag.name, path: '', historyPath: undefined })} onClick={()=>choose('tag',tag.name)}><Tag size={15}/><span>{tag.name}<small>Listed at {shortSHA(tag.commitId)}</small></span></Link></li>)}</ul>
          {!(kind === 'branches' ? branches : tags).some(item => matches(item.name)) ? <p className="muted">{search ? `No loaded ${kind} match your search.` : `No ${kind} available.`}</p> : null}
          <More hasMore={query.hasNextPage} loading={query.isFetchingNextPage} load={() => void query.fetchNextPage()} label={kind}/>
        </>}
      </div>
    </details>
    <button className="text-button ref-inventory-button" type="button" onClick={() => open('branches')}><GitBranch size={15}/>{count(branchesQuery.data)}Branches</button>
    <button className="text-button ref-inventory-button" type="button" onClick={() => open('tags')}><Tag size={15}/>{count(tagsQuery.data)}Tags</button>
    {onLatest && !unresolvedSource && (location.refKind || !location.ref || branchName || location.tag) ? <button className="icon-button branch-refresh" title={location.refKind === 'tag' || location.tag ? 'Latest tag version' : 'Latest branch head'} aria-label={location.refKind === 'tag' || location.tag ? 'Latest tag version' : 'Latest branch head'} disabled={latestPending} onClick={latest}><RefreshCw size={14}/></button> : !onLatest && branchName ? <button className="icon-button branch-refresh" title="Latest branch head" aria-label="Latest branch head" onClick={() => void navigate(repositoryOptions(location, { ref: branchName, branch: branchName, tag: undefined }))}><RefreshCw size={14}/></button> : null}
    {pinnedCommitId || location.ref && isCommitID(location.ref) ? <span className="commit-pin" title={pinnedCommitId || location.ref}><LockKeyhole size={12}/>{shortSHA(pinnedCommitId || location.ref)}</span> : null}
  </div>;
}
