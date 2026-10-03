import {useEffect,useRef,useState} from 'react';
import {ChevronRight,GitBranch,ShieldCheck} from 'lucide-react';
import type {Branch} from './gen/golf/v1/golf_pb';
import {disclosureDismiss,fitDisclosure,Loading,More,PanelError,shortSHA} from './RepositoryUI';

// Shared native disclosure; search explicitly covers loaded pages only.
export function BranchPicker({label='Choose a branch',selected,branches,pending,error,hasMore,loadingMore,onMore,onRetry,onSelect,disabled=false}:{label?:string;selected:string;branches:Branch[];pending:boolean;error:Error|null;hasMore:boolean;loadingMore:boolean;onMore:()=>void;onRetry:()=>void;onSelect:(branch:Branch)=>void;disabled?:boolean}) {
 const details=useRef<HTMLDetailsElement>(null);const [search,setSearch]=useState('');
 useEffect(()=>{if(details.current?.open)fitDisclosure(details.current,'.branch-options');},[branches,pending,error,search]);
 const shown=branches.filter(branch=>branch.name.toLowerCase().includes(search.toLowerCase()));
 return <details className="ref-picker branch-picker" ref={details} {...disclosureDismiss} onToggle={event=>{if(!event.currentTarget.open)setSearch('');else fitDisclosure(event.currentTarget,'.branch-options');}}>
  <summary aria-label={label} aria-disabled={disabled} onClick={event=>{if(disabled)event.preventDefault();}}><GitBranch size={16}/><span>{selected||'Choose a branch'}</span><ChevronRight size={14}/></summary>
  <div className="branch-options"><strong>{label}</strong><input className="branch-search" type="search" aria-label={label==='Choose a branch'?'Search loaded branches':`Search loaded ${label.toLowerCase()}es`} placeholder="Search loaded branches…" value={search} onChange={event=>setSearch(event.target.value)} disabled={disabled} autoComplete="off"/><p className="field-help">Search covers loaded branches.</p>
   {error?<PanelError error={error} retry={onRetry}/>:pending?<Loading label="Loading branches…"/>:<><ul>{shown.map(branch=><li key={branch.name}><button type="button" disabled={disabled} onClick={()=>{onSelect(branch);if(details.current)details.current.open=false;}}><GitBranch size={15}/><span>{branch.name}<small>Listed at {shortSHA(branch.commitId)}</small></span>{branch.protected?<ShieldCheck size={15} aria-label="Protected branch"/>:null}</button></li>)}</ul>{!shown.length?<p className="muted">{search?'No loaded branches match your search.':'No branches available.'}</p>:null}<More hasMore={hasMore} loading={loadingMore||disabled} load={onMore} label="branches"/></>}
  </div>
 </details>;
}
