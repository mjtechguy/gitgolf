import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Columns2, List, ListFilter, PanelLeftClose, PanelLeftOpen, Search, Settings2 } from 'lucide-react';
import { parseDiff } from './diff';
import type { DiffFile } from './diff';
import { Hunk, type DiffCoordinate, type DiffLineActions } from './DiffHunk';
import { DiffNavigation } from './DiffNavigation';
import { diffSelection } from './diffSelection';
import { sourceLanguage } from './sourceLanguage';
import { CopyButton, disclosureDismiss, fitDisclosure, useFragment } from './RepositoryUI';

const SyntaxHunk=lazy(()=>import('./DiffSyntax'));
const preferenceKey='golf.diff-display.v1';
type Preferences={split:boolean;wrap:boolean;syntax:boolean;tree:boolean};
function preferences():Preferences {
 const defaults={split:false,wrap:false,syntax:true,tree:window.matchMedia('(min-width: 761px)').matches};
 try {const saved:unknown=JSON.parse(localStorage.getItem(preferenceKey)||'null');if(saved && typeof saved==='object')for(const key of Object.keys(defaults) as (keyof Preferences)[]) {const value=(saved as Record<string,unknown>)[key];if(typeof value==='boolean')defaults[key]=value;}} catch { /* Display works when browser storage is unavailable. */ }
 return defaults;
}
function extension(path:string) {const filename=path.split('/').pop()||'';const dot=filename.lastIndexOf('.');return dot>0&&dot<filename.length-1?filename.slice(dot).toLowerCase():'';}
function FilePatch({ file, id, split, syntax, fileIndex, ...actions }: { file: DiffFile; id: string; split: boolean; syntax:boolean;fileIndex:number } & DiffLineActions) {
 const rows=file.hunks.reduce((count,hunk)=>count+hunk.lines.length,0);
 if(!file.valid||rows>12000)return <><p className="panel-footnote">{!file.valid?'This patch format cannot be mapped safely to line numbers.':'This large patch exceeds the structured preview limit.'} Native text is shown below.</p><pre className="source-preview" tabIndex={0}><code>{file.raw}</code></pre></>;
 const language=syntax && file.raw.length<=65536 && rows<=2000 ? sourceLanguage(file.path):'';
 return <>
  {file.headers.slice(1).filter(Boolean).length?<details className="metadata-details diff-file-metadata"><summary>File metadata{file.oldPath&&file.oldPath!==file.path?` · renamed from ${file.oldPath}`:''}</summary>{file.headers.slice(1).filter(Boolean).map((header,index)=><div key={index}><code>{header}</code></div>)}</details>:null}
  {file.binary?<p className="panel-footnote">Binary content changed. No text preview is available.</p>:null}
  {file.hunks.length?<div className="diff-scroll" tabIndex={0} aria-label={`Changes in ${file.path}`}><table className={`diff-lines ${split?'split':'unified'}`}><tbody>{file.hunks.map((hunk,index)=>{
   const props={lines:hunk.lines,header:hunk.header,id,split,fileIndex,hunkIndex:index,path:file.path,oldPath:file.oldPath,...actions};
   return language?<Suspense key={index} fallback={<Hunk {...props}/>}><SyntaxHunk {...props} language={language}/></Suspense>:<Hunk key={index} {...props}/>;
  })}</tbody></table></div>:!file.binary?<p className="panel-footnote">No supported text hunks in this file.</p>:null}
 </>;
}
function ChangedFile({file,id,split,syntax,viewed,onViewed,collapsed,onCollapsed,fileIndex,...actions}:{file:DiffFile;id:string;split:boolean;syntax:boolean;viewed:boolean;onViewed:(value:boolean)=>void;collapsed:boolean;onCollapsed:(value:boolean)=>void;fileIndex:number}&DiffLineActions) {
 const expanded=!collapsed;const slash=file.path.lastIndexOf('/');
 return <section id={id} className="diff-file"><div className="diff-file-heading"><button className="diff-file-toggle" aria-expanded={expanded} aria-controls={`${id}-patch`} aria-label={`${expanded?'Collapse':'Expand'} ${file.path}`} onClick={()=>onCollapsed(expanded)}>{expanded?<ChevronDown size={16}/>:<ChevronRight size={16}/>}<code title={file.path}>{slash>=0?<span className="diff-path-parent">{file.path.slice(0,slash+1)}</span>:null}<strong>{file.path.slice(slash+1)}</strong></code></button><CopyButton text={file.path} label={`Copy path ${file.path}`}/><span className="diff-stats"><span className="diff-added">+{file.additions}</span><span className="diff-deleted">−{file.deletions}</span></span><label className="diff-viewed"><input type="checkbox" checked={viewed} onChange={event=>{onViewed(event.target.checked);onCollapsed(event.target.checked);}}/>Viewed</label></div><div id={`${id}-patch`} hidden={!expanded}>{expanded?<FilePatch file={file} id={id} split={split} syntax={syntax} fileIndex={fileIndex} {...actions}/>:null}</div></section>;
}

// Parent keys this workspace by actor, repository and comparison identity.
// Only display booleans persist; filters, names and Viewed stay private/in-memory.
export function DiffViewer({text,snapshotId,toolbarAction,...actions}:{text:string;snapshotId:string;toolbarAction?:ReactNode}&DiffLineActions) {
 const prefix=`diff-${snapshotId.replace(/[^a-zA-Z0-9-]/g,'')}`;
 const {files,preamble}=useMemo(()=>parseDiff(text),[text]);
 const [display,setDisplay]=useState(preferences);
 const [filter,setFilter]=useState('');
 const [excluded,setExcluded]=useState<Set<string>>(()=>new Set());
 const [view,setView]=useState('all');
 const [viewed,setViewed]=useState<Set<number>>(()=>new Set());
 const [collapsed,setCollapsed]=useState<Set<number>>(()=>new Set());
 const collapseFile=(index:number,value:boolean)=>setCollapsed(before=>{const next=new Set(before);if(value)next.add(index);else next.delete(index);return next;});
 const fragment=useFragment();const selection=useMemo(()=>diffSelection(fragment,prefix,files),[fragment,prefix,files]);
 const anchor=useRef<{prefix:string;text:string;fragment:string;coordinate:DiffCoordinate}|undefined>(undefined);
 useLayoutEffect(()=>{anchor.current=undefined;},[prefix,text]);
 const selected=selection?.fileIndex;
 const lineActions={...actions,lineSelection:selection,onLineSelect:(coordinate:DiffCoordinate,extend:boolean)=>{
  // A Shift pivot belongs only to this exact snapshot and displayed fragment.
  const saved=anchor.current;const previous=saved?.prefix===prefix&&saved.text===text&&saved.fragment===fragment?saved.coordinate:undefined;
  const same=previous?.fileIndex===coordinate.fileIndex&&previous.side===coordinate.side;
  const origin=extend?(same?previous.line:selection?.fileIndex===coordinate.fileIndex&&selection.side===coordinate.side?selection.first??coordinate.line:coordinate.line):coordinate.line;
  const side=coordinate.side==='old'?'L':'R',first=Math.min(origin,coordinate.line),last=Math.max(origin,coordinate.line);
  const range=`#${prefix}-file-${coordinate.fileIndex}-${side}${first}${last===first?'':'-'+side+last}`;
  const valid=diffSelection(range,prefix,files),next=valid?range:`#${prefix}-file-${coordinate.fileIndex}-${side}${coordinate.line}`;
  anchor.current={prefix,text,fragment:next,coordinate:extend&&valid?{...coordinate,line:origin}:coordinate};
  window.location.hash=next;
 }};
 useEffect(()=>{try {localStorage.setItem(preferenceKey,JSON.stringify(display));}catch{/* Private content never enters preference storage. */}},[display]);
 useEffect(()=>{
  if(selection?.side===undefined||selection.first===undefined)return;
  setCollapsed(before=>{if(!before.has(selection.fileIndex))return before;const next=new Set(before);next.delete(selection.fileIndex);return next;});
  const frame=requestAnimationFrame(()=>document.getElementById(`${prefix}-file-${selection.fileIndex}-${selection.side==='old'?'L':'R'}${selection.first}`)?.scrollIntoView({block:'nearest'}));
  return()=>cancelAnimationFrame(frame);
 },[fragment,prefix,selection]);
 useEffect(()=>{
  const close=()=>document.querySelectorAll<HTMLDetailsElement>(`details[name="${prefix}-options"]`).forEach(menu=>{if(menu.open){menu.open=false;if(menu.contains(document.activeElement))menu.querySelector('summary')?.focus();}});
  window.addEventListener('resize',close);return()=>window.removeEventListener('resize',close);
 },[prefix]);
 const large=files.length>500||files.reduce((count,file)=>count+file.hunks.reduce((rows,hunk)=>rows+hunk.lines.length,0),0)>12000;
 const entries=useMemo(()=>files.map((file,index)=>({file,index})),[files]);
 const extensions=useMemo(()=>large?[]:[...new Set(files.map(file=>extension(file.path)))].sort(),[files,large]);
 const shown=useMemo(()=>entries.filter(({file,index})=>`${file.path}\n${file.oldPath}`.toLowerCase().includes(filter.toLowerCase())&&!excluded.has(extension(file.path))&&(view==='all'||(view==='viewed')===viewed.has(index))),[entries,filter,excluded,view,viewed]);
 const setPreference=(key:keyof Preferences,value:boolean)=>setDisplay(before=>({...before,[key]:value}));
 const filtered=Boolean(filter||excluded.size||view!=='all');
 const clearFilters=()=>{setFilter('');setExcluded(new Set());setView('all');};
 if(large)return <section className="diff-workspace" aria-label="Changed files"><div className="diff-toolbar"><h2>Files changed</h2>{toolbarAction}</div><p className="panel-footnote">This comparison exceeds the structured preview limit of 500 files or 12,000 rows. The complete bounded native text remains available.</p><pre className="source-preview" tabIndex={0} aria-label="Unified diff, plain text"><code>{text}</code></pre></section>;
 return <section className={`diff-workspace ${display.wrap?'wrap-lines':''}`} aria-label="Changed files">
  <div className="diff-toolbar"><div className="diff-summary"><h2>Files changed</h2><strong>{files.length} {files.length===1?'file':'files'}</strong><span className="diff-stats"><span className="diff-added">+{files.reduce((sum,file)=>sum+file.additions,0)}</span><span className="diff-deleted">−{files.reduce((sum,file)=>sum+file.deletions,0)}</span></span><span className="muted diff-viewed-count" title="Viewed markers apply to this browser session and snapshot">{viewed.size}/{files.length} viewed<span className="diff-session-label"> this session</span></span></div><div className="content-view-controls">{toolbarAction}</div>
  <div className="diff-controls"><button className={`text-button ${!display.split?'active':''}`} aria-label="Unified" title="Unified diff" aria-pressed={!display.split} onClick={()=>setPreference('split',false)}><List size={15} aria-hidden="true"/><span className="diff-mode-label">Unified</span></button><button className={`text-button ${display.split?'active':''}`} aria-label="Split" title="Split diff" aria-pressed={display.split} onClick={()=>setPreference('split',true)}><Columns2 size={15} aria-hidden="true"/><span className="diff-mode-label">Split</span></button><button className="icon-button" aria-label={display.tree?'Hide file tree':'Show file tree'} title={display.tree?'Hide file tree':'Show file tree'} aria-pressed={display.tree} onClick={()=>setPreference('tree',!display.tree)}>{display.tree?<PanelLeftClose size={16}/>:<PanelLeftOpen size={16}/>}</button>
   <details className="diff-options" name={prefix+'-options'} {...disclosureDismiss} onToggle={event=>fitDisclosure(event.currentTarget,'.diff-options-content')}><summary aria-label="File filter" title="File filter"><ListFilter size={16} aria-hidden="true"/><span className="diff-filter-label">File filter</span><ChevronDown size={13} aria-hidden="true"/></summary><div className="diff-options-content"><strong>Loaded file types</strong><div className="diff-extension-options">{extensions.map(ext=><label key={ext}><input type="checkbox" checked={!excluded.has(ext)} onChange={event=>setExcluded(before=>{const next=new Set(before);if(event.target.checked)next.delete(ext);else next.add(ext);return next;})}/>{ext||'No extension'}</label>)}</div><label>Viewed files<select aria-label="Viewed files visibility" value={view} onChange={event=>setView(event.target.value)}><option value="all">All files</option><option value="unviewed">Not viewed</option><option value="viewed">Viewed only</option></select></label><button className="text-button" onClick={clearFilters} disabled={!filtered}>Reset file filters</button></div></details>
   <details className="diff-options" name={prefix+'-options'} {...disclosureDismiss} onToggle={event=>fitDisclosure(event.currentTarget,'.diff-options-content')}><summary aria-label="Diff settings" title="Diff settings"><Settings2 size={16}/><ChevronDown size={13}/></summary><div className="diff-options-content"><strong>Display preferences</strong><label><input type="checkbox" checked={display.wrap} onChange={event=>setPreference('wrap',event.target.checked)}/>Wrap lines</label><label><input type="checkbox" checked={display.syntax} onChange={event=>setPreference('syntax',event.target.checked)}/>Syntax colours</label></div></details>
   <span className={filtered?"muted":"sr-only"} role="status">{filtered?`Showing ${shown.length} of ${files.length} changed files`:'Loaded comparison'}</span>{filtered?<button className="text-button" onClick={clearFilters}>Clear filters</button>:null}
  </div></div>
  <div className={`diff-layout ${!display.tree?'without-tree':''}`}>{display.tree?<aside className="diff-files"><label className="diff-search"><Search size={15}/><input aria-label="Filter changed files" placeholder="Filter changed files…" value={filter} onChange={event=>setFilter(event.target.value)}/></label><DiffNavigation entries={shown} prefix={prefix} viewed={viewed} selected={selected} onSelect={index=>collapseFile(index,false)}/></aside>:null}<div className="diff-patches">
   {preamble?<details className="diff-preamble"><summary>Native commit header</summary><pre>{preamble}</pre></details>:null}
   {shown.map(({file,index})=><ChangedFile key={index} file={file} fileIndex={index} {...lineActions} id={`${prefix}-file-${index}`} split={display.split} syntax={display.syntax} viewed={viewed.has(index)} collapsed={collapsed.has(index)} onCollapsed={value=>collapseFile(index,value)} onViewed={value=>setViewed(before=>{const next=new Set(before);if(value)next.add(index);else next.delete(index);return next;})}/>)}
   {!shown.length?<p className="empty-state">{files.length?'No files match this filter.':'No structured file changes in this output.'}</p>:null}
  </div></div>
  <details className="diff-raw" open={!files.length}><summary>Native diff text</summary><pre className="source-preview" tabIndex={0} aria-label="Unified diff, plain text"><code>{text}</code></pre></details>
 </section>;
}
