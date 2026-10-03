import {useEffect,useRef,useState} from 'react';
import {useForm,useStore} from '@tanstack/react-form';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {Link,useNavigate} from '@tanstack/react-router';
import {Code,ConnectError} from '@connectrpc/connect';
import {ArrowLeft,ArrowRightLeft,GitCompareArrows,GitPullRequest} from 'lucide-react';
import {repositoryClient} from './api';
import {repositoryOptions} from './navigation';
import type {RepositoryLocation} from './navigation';
import type {Branch,Repository,RepositoryComparisonSelection} from './gen/golf/v1/golf_pb';
import {useRepositoryLive} from './RepositoryLive';
import {BranchPicker} from './BranchPicker';
import {CommitList} from './CommitList';
import {DiffViewer} from './DiffViewer';
import {DiscussionComposer} from './IssueBrowser';
import {issueIntentKey,readIssueIntent} from './issueIntents';
import {disclosureDismiss,fitDisclosure,Loading,PanelError,nextPage,privateQuery,shortSHA} from './RepositoryUI';

type Props={location:RepositoryLocation;repository:Repository;queryKey:readonly unknown[];userId:string;onEditingChange?:(editing:boolean)=>void;comparisonStale?:boolean};
function useBranches(userId:string,owner:string,name:string) {
 const query=useInfiniteQuery({...privateQuery,queryKey:['repository',userId,owner,name,'branches'],initialPageParam:1,queryFn:({signal,pageParam})=>repositoryClient.listBranches({repository:{owner,name},page:{page:pageParam}},{signal,timeoutMs:8000}),getNextPageParam:nextPage});
 const branches=query.isSuccess&&(!query.isFetching||query.isFetchingNextPage)?[...new Map(query.data.pages.flatMap(p=>p.branches).map(b=>[b.name,b])).values()]:[];
 return {query,branches};
}
function SourcePicker({location,disabled}:{location:RepositoryLocation;disabled:boolean}) {
 const navigate=useNavigate();const menu=useRef<HTMLDetailsElement>(null);const [error,setError]=useState('');
 const selected=(location.sourceOwner||location.owner)+'/'+(location.sourceName||location.name);
 const form=useForm({defaultValues:{name:selected},onSubmit:({value})=>{
  const parts=value.name.trim().split('/');if(parts.length!==2||parts.some(p=>!p||/[\\\u0000-\u001f]/.test(p))){setError('Use owner/repository.');return;}
  void navigate(repositoryOptions(location,{sourceOwner:parts[0],sourceName:parts[1],head:undefined}));if(menu.current)menu.current.open=false;
 }});const name=useStore(form.store,s=>s.values.name);
 return <details className="ref-picker compare-source-picker" ref={menu} {...disclosureDismiss} onToggle={event=>{if(event.currentTarget.open)fitDisclosure(event.currentTarget,'.branch-options');}}><summary aria-label="Choose source repository" aria-disabled={disabled} onClick={event=>{if(disabled)event.preventDefault();}}><GitCompareArrows size={16}/><span>{selected}</span></summary><form className="branch-options" onSubmit={event=>{event.preventDefault();if(!disabled)void form.handleSubmit();}}><label htmlFor="compare-source">Source repository</label><input id="compare-source" value={name} disabled={disabled} onChange={event=>form.setFieldValue('name',event.target.value)} placeholder="owner/repository" autoComplete="off"/><p className="field-help">Use a repository you can read, including a renamed fork. Access is checked independently.</p>{error?<p role="alert" className="error">{error}</p>:null}<button className="button secondary" disabled={disabled}>Choose repository</button></form></details>;
}
function ComparedChanges({selection,...props}:Props & {selection:RepositoryComparisonSelection}) {
 const navigate=useNavigate();const [composing,setComposing]=useState(false);
 const [tab,setTab]=useState<'files'|'commits'>('files');const [epoch,setEpoch]=useState(0);const query=useQuery({...privateQuery,queryKey:[...props.queryKey,'comparison',selection.sourceRepositoryId,selection.baseBranch,selection.headBranch,selection.baseCommitId,selection.headCommitId,epoch],queryFn:async({signal})=>{
  const result=await repositoryClient.getRepositoryComparison({selection},{signal,timeoutMs:15000});const observed=result.selection;
  if(!observed||observed.repository?.owner!==selection.repository?.owner||observed.repository?.name!==selection.repository?.name||observed.sourceRepository?.owner!==selection.sourceRepository?.owner||observed.sourceRepository?.name!==selection.sourceRepository?.name||['repositoryId','sourceRepositoryId','baseBranch','headBranch','baseCommitId','headCommitId'].some(field=>observed[field as keyof RepositoryComparisonSelection]!==selection[field as keyof RepositoryComparisonSelection]))throw new ConnectError('The comparison does not match the selected repositories and commits.',Code.FailedPrecondition);
  if(result.byteSize>512*1024||new TextEncoder().encode(result.rawDiff).byteLength!==result.byteSize||result.commits.length>500)throw new ConnectError('The comparison exceeds its supported preview bounds.',Code.ResourceExhausted);
  return result;
 }});
 const source={...props.location,owner:selection.sourceRepository!.owner,name:selection.sourceRepository!.name};
 const resumed=Boolean(readIssueIntent(issueIntentKey(props.userId,props.repository.id,'new-pull'),props.repository.id,'',0,'pull'));
 return <>
  {query.isError?<PanelError error={query.error} retry={()=>setEpoch(n=>n+1)}/>:query.isPending?<Loading label="Reading compared commits and files…"/>:query.data?<>
   {props.comparisonStale?<p className="session-notice" role="status">Branch observations changed or are being rechecked. Close the editor and compare again before creating a pull request.</p>:null}
   <div className="comparison-result-heading"><span><GitCompareArrows size={17}/>{query.data.commits.length} compared commits</span><span className="muted">{shortSHA(selection.baseCommitId)} ← {shortSHA(selection.headCommitId)}</span>{!composing?<button className="button primary" disabled={props.comparisonStale||!query.data.commits.length&&!query.data.rawDiff} onClick={()=>{setComposing(true);props.onEditingChange?.(true);}}><GitPullRequest size={16}/>Open pull request</button>:null}</div>
   {composing?<section className="browser-panel" aria-label="New pull request"><div className="browser-panel-heading"><h2>Open a pull request</h2></div><div className="issue-edit-content"><DiscussionComposer {...props} repositoryKey={{owner:props.location.owner,name:props.location.name}} repositoryId={props.repository.id} onPending={props.onEditingChange} creation={selection} blocked={props.comparisonStale} initialTitle={query.data.commits.length===1?query.data.commits[0]!.message.split('\n')[0]:''} onClose={()=>{setComposing(false);props.onEditingChange?.(false);}} onPullCreated={pull=>void navigate(repositoryOptions(props.location,{view:'pulls',pull:pull.number,pullView:undefined}))}/></div></section>:null}
   <div className="content-view-controls" aria-label="Comparison view"><button className={`text-button ${tab==='files'?'active':''}`} aria-pressed={tab==='files'} onClick={()=>setTab('files')}>Files changed</button><button className={`text-button ${tab==='commits'?'active':''}`} aria-pressed={tab==='commits'} onClick={()=>setTab('commits')}>Commits</button></div>
   {tab==='files'?<section className="browser-panel"><DiffViewer text={query.data.rawDiff} snapshotId={selection.baseCommitId+'-'+selection.headCommitId}/></section>:<section className="browser-panel commit-history"><CommitList commits={query.data.commits} location={source}/>{!query.data.commits.length?<div className="empty-state">No compared commits returned.</div>:null}</section>}
   {!query.data.commits.length&&!query.data.rawDiff?<p className="session-notice" role="status">There are no changes in this comparison.</p>:null}
   <p className="field-help">Native merge-base comparison, bounded to 512 KiB and 500 returned commits. Branches and access are rechecked; this does not determine merge availability.</p>
  </>:null}
  {query.isError&&resumed?<section className="browser-panel"><div className="issue-edit-content"><DiscussionComposer {...props} repositoryKey={{owner:props.location.owner,name:props.location.name}} repositoryId={props.repository.id} onPending={props.onEditingChange} creation={selection} onPullCreated={pull=>void navigate(repositoryOptions(props.location,{view:'pulls',pull:pull.number}))}/></div></section>:null}
 </>;
}
export function RepositoryCompare(props:Props) {
 const {location,repository,userId}=props;const navigate=useNavigate();
 const sourceOwner=location.sourceOwner||location.owner,sourceName=location.sourceName||location.name;
 const source=useQuery({...privateQuery,queryKey:['repository',userId,sourceOwner,sourceName,'metadata'],queryFn:({signal})=>repositoryClient.getRepository({repository:{owner:sourceOwner,name:sourceName}},{signal,timeoutMs:8000}).then(response=>{if(!response.repository)throw new ConnectError('Source repository metadata is missing.',Code.Unavailable);return response.repository;})});
 const base=useBranches(userId,location.owner,location.name),head=useBranches(userId,sourceOwner,sourceName);
 const baseName=location.base||repository.defaultBranch,headName=location.head||location.branch||'';
 const baseBranch=base.branches.find(b=>b.name===baseName),headBranch=head.branches.find(b=>b.name===headName);
 const [selected,setSelected]=useState<RepositoryComparisonSelection|null>(null);const [editing,setEditing]=useState(false);
 const resumed=Boolean(readIssueIntent(issueIntentKey(userId,repository.id,'new-pull'),repository.id,'',0,'pull'));
 const locked=editing||resumed;
 function compare(){if(!baseBranch||!headBranch||!source.data)return;setSelected({$typeName:'golf.v1.RepositoryComparisonSelection',repository:{$typeName:'golf.v1.RepositoryKey',owner:location.owner,name:location.name},repositoryId:repository.id,sourceRepository:{$typeName:'golf.v1.RepositoryKey',owner:sourceOwner,name:sourceName},sourceRepositoryId:source.data.id,baseBranch:baseBranch.name,headBranch:headBranch.name,baseCommitId:baseBranch.commitId,headCommitId:headBranch.commitId});}
 const sourceLive=useRepositoryLive(userId,sourceOwner,sourceName,source.data?.id,'',Boolean(source.data&&source.data.id!==repository.id&&!source.isError),true);
 const accessFailed=source.isError||base.query.isError||head.query.isError;
 useEffect(()=>{if(accessFailed){setSelected(null);setEditing(false);}},[accessFailed]);
 const selectionMatches=!accessFailed&&selected&&selected.repositoryId===repository.id&&selected.sourceRepositoryId===source.data?.id&&selected.baseBranch===baseName&&selected.headBranch===headName&&selected.sourceRepository?.owner===sourceOwner&&selected.sourceRepository.name===sourceName;
 function picker(label:string,state:ReturnType<typeof useBranches>,branch:Branch|undefined,field:'base'|'head') {return <BranchPicker disabled={locked} label={label} selected={branch?.name||(field==='base'?baseName:headName)} branches={state.branches} pending={state.query.isPending||state.query.isFetching&&!state.query.isFetchingNextPage} error={state.query.error} hasMore={Boolean(state.query.hasNextPage)} loadingMore={state.query.isFetchingNextPage} onMore={()=>void state.query.fetchNextPage()} onRetry={()=>void state.query.refetch()} onSelect={value=>{setSelected(null);void navigate(repositoryOptions(location,{[field]:value.name}));}}/>;}
 return <div className="repository-comparison"><header className="discussion-summary"><div className="discussion-navigation"><Link className="text-button" {...repositoryOptions(location,{view:'pulls'})}><ArrowLeft size={15}/>Pull requests</Link></div><h2>Compare changes</h2><p className="field-help">Choose the destination base and your source branch, inspect the changes, then open a pull request.</p></header><section className="comparison-selectors" aria-label="Comparison branches"><div className="comparison-side"><span className="muted">Base: {location.owner}/{location.name}</span>{picker('Base branch',base,baseBranch,'base')}</div><ArrowLeft size={16}/><div className="comparison-side"><SourcePicker key={sourceOwner+'/'+sourceName} location={location} disabled={locked}/>{picker('Compare branch',head,headBranch,'head')}</div><button className="button secondary" onClick={compare} disabled={locked||!baseBranch||!headBranch||source.isFetching||source.isError}><GitCompareArrows size={16}/>Compare</button>{sourceOwner===location.owner&&sourceName===location.name?<button className="icon-button" aria-label="Swap base and compare branches" title="Swap base and compare branches" disabled={locked||!baseBranch||!headBranch} onClick={()=>{setSelected(null);void navigate(repositoryOptions(location,{base:headName,head:baseName}));}}><ArrowRightLeft size={16}/></button>:null}</section>
  {sourceLive.newSource?<p className="field-help">The source repository has new activity. Your displayed comparison stays pinned.</p>:null}
  {base.query.isError?<PanelError error={base.query.error} retry={()=>void base.query.refetch()}/>:null}
  {head.query.isError&&(sourceOwner!==location.owner||sourceName!==location.name)?<PanelError error={head.query.error} retry={()=>void head.query.refetch()}/>:null}
  {source.isError?<PanelError error={source.error} retry={()=>void source.refetch()}/>:null}
  {resumed&&!selectionMatches?<section className="browser-panel" aria-label="Pending pull request"><div className="browser-panel-heading"><h2>Inspect pending pull request</h2></div><div className="issue-edit-content"><DiscussionComposer {...props} onPending={setEditing} repositoryKey={{owner:location.owner,name:location.name}} repositoryId={repository.id} creation={{$typeName:'golf.v1.RepositoryComparisonSelection',repository:{$typeName:'golf.v1.RepositoryKey',owner:location.owner,name:location.name},repositoryId:repository.id,sourceRepository:undefined,sourceRepositoryId:'',baseBranch:'',headBranch:'',baseCommitId:'',headCommitId:''}} onPullCreated={pull=>void navigate(repositoryOptions(location,{view:'pulls',pull:pull.number}))}/></div></section>:null}
  {!selectionMatches?<div className="empty-state"><GitCompareArrows size={24}/><h3>Select branches to compare</h3><p>Branch lists are paged. Load more in either selector to find additional branches.</p></div>:<ComparedChanges key={[selected.repositoryId,selected.sourceRepositoryId,selected.baseBranch,selected.headBranch,selected.baseCommitId,selected.headCommitId].join(':')} {...props} onEditingChange={setEditing} comparisonStale={!baseBranch||!headBranch||baseBranch.commitId!==selected.baseCommitId||headBranch.commitId!==selected.headCommitId} selection={selected}/>}
 </div>;
}
