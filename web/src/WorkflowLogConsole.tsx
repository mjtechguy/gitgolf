import {Fragment,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {ArrowDownToLine,ArrowUp,Download,Search} from 'lucide-react';
import {CopyButton,downloadText} from './RepositoryUI';

export interface WorkflowLogConsoleProps {
 scopeKey:string;
 text:string;
 authorized:boolean;
 status:'idle'|'streaming'|'reconnecting';
 fileName:string;
 hasMore?:boolean;
 refreshing?:boolean;
}
const windowSize=2000;
type Style={color?:number;bold:boolean};
type Line={text:string;style:Style};
const escape=/\x1b\[[0-?]*[ -/]*[@-~]/g;
function updateStyle(style:Style,sequence:string):Style {
 const codes=sequence.slice(2,-1).split(';').map(value=>Number(value||0));let next={...style};
 for(let i=0;i<codes.length;i++) {
  const code=codes[i]!;
  if(code===0)next={bold:false};else if(code===1)next.bold=true;else if(code===22)next.bold=false;else if(code===39)delete next.color;
  else if(code>=30&&code<=37||code>=90&&code<=97)next.color=code;
  else if(code===38||code===48)i+=codes[i+1]===2?4:codes[i+1]===5?2:0;
 }
 return next;
}
function model(text:string) {
 // OSC links/titles and cursor/control instructions never become HTML, links,
 // DOM attributes or terminal commands. SGR's closed colors are presentational.
 const safe=text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g,'');
 let style:Style={bold:false};const lines:Line[]=[];
 for(const raw of safe.split('\n')) {
  const line={text:raw,style:{...style}};
  for(const match of raw.matchAll(escape))if(match[0].endsWith('m'))style=updateStyle(style,match[0]);
  lines.push(line);
 }
 const plain=lines.map(line=>line.text.replace(escape,'').replace(/\x1b[^\n]*/g,'')).join('\n');
 return {lines,plain};
}

// No queries or persistence: the parent supplies only validated, currently
// authorized bytes and actual live-transport state. Scope change remounts every
// private control; background fetching alone must not erase the observation.
export function WorkflowLogConsole(props:WorkflowLogConsoleProps) {
 return props.authorized?<Console key={props.scopeKey} {...props}/>:null;
}
function Console({text,status,fileName,hasMore=false,refreshing=false}:WorkflowLogConsoleProps) {
 const data=useMemo(()=>model(text),[text]);const viewport=useRef<HTMLPreElement>(null),id=useId();
 const [follow,setFollow]=useState(true),[end,setEnd]=useState(data.lines.length),[search,setSearch]=useState(''),[searchOpen,setSearchOpen]=useState(false);
 const stop=()=>{if(follow){setEnd(data.lines.length);setFollow(false);}};
 const windowEnd=follow?data.lines.length:Math.min(end,data.lines.length),start=Math.max(0,windowEnd-windowSize);
 const needle=search.toLowerCase();
 const matches=useMemo(()=>needle?data.plain.toLowerCase().split(needle).length-1:0,[data.plain,needle]);
 const rows=useMemo(()=>{
  let spans=0,marks=0;
  function highlighted(value:string):ReactNode {
   if(!needle||marks>=200)return value;
   const parts:ReactNode[]=[];let cursor=0;const lower=value.toLowerCase();
   while(marks<200){const found=lower.indexOf(needle,cursor);if(found<0)break;parts.push(value.slice(cursor,found),<mark key={found}>{value.slice(found,found+search.length)}</mark>);cursor=found+search.length;marks++;}
   parts.push(value.slice(cursor));return parts;
  }
  return data.lines.slice(start,windowEnd).map((line,index)=>{
   let cursor=0,style={...line.style};const parts:ReactNode[]=[];
   function part(value:string){if(!value)return;const className=[style.color?`execution-ansi-${style.color}`:'',style.bold?'execution-ansi-bold':''].filter(Boolean).join(' ');parts.push(<span key={parts.length} className={className||undefined}>{highlighted(value)}</span>);}
   for(const match of line.text.matchAll(escape)){
    if(++spans>4000)break;
    part(line.text.slice(cursor,match.index));cursor=match.index+match[0].length;
    if(match[0].endsWith('m'))style=updateStyle(style,match[0]);
   }
   part(line.text.slice(cursor).replace(escape,'').replace(/\x1b[^\n]*/g,''));
   return <Fragment key={start+index}><span className="execution-console-line" data-line={start+index+1}>{parts}</span>{start+index<data.lines.length-1?'\n':null}</Fragment>;
  });
 },[data,start,windowEnd,needle,search]);
 useLayoutEffect(()=>{if(follow&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;},[follow,text]);
 const name=fileName.replace(/[^A-Za-z0-9._-]/g,'-').slice(0,180)||'golf-run.log';
 return <div className="execution-console">
  <div className="execution-console-toolbar">
   <div className="search-input" data-open={searchOpen} id={id+'-controls'}><label className="sr-only" htmlFor={id}>Search loaded run log</label><Search size={16} aria-hidden="true"/><input id={id} type="search" placeholder="Search loaded log…" value={search} onChange={event=>setSearch(event.target.value)} maxLength={256}/></div>
   <div className="row-actions"><button type="button" className="icon-button workflow-log-search-toggle" aria-label="Search loaded run log" title="Search loaded run log" aria-expanded={searchOpen} aria-controls={id+'-controls'} onClick={()=>setSearchOpen(value=>!value)}><Search size={16}/></button><CopyButton text={data.plain} label="Copy loaded log"/><button type="button" className="icon-button" aria-label="Download loaded log" title="Download loaded log" disabled={!text} onClick={()=>downloadText(data.plain,name)}><Download size={16}/></button><button type="button" className="button secondary" aria-label="Follow output" title="Follow output" aria-pressed={follow} onClick={()=>{setEnd(data.lines.length);setFollow(value=>!value);}}><ArrowDownToLine size={16}/>Follow</button></div>
  </div>
  <div className="execution-console-status" role="status"><span>{status==='streaming'?'Live output':status==='reconnecting'?'Reconnecting to live output':'Loaded output'}{refreshing?' · Refreshing':''}</span><span>{search?`${matches} match${matches===1?'':'es'} · up to 200 visible highlights`:hasMore?'More output available':''}</span></div>
  {data.lines.length>windowSize?<div className="execution-console-window"><span>Lines {start+1}–{windowEnd} of {data.lines.length} loaded</span><button type="button" className="text-button" disabled={start===0} onClick={()=>{setEnd(start);setFollow(false);}}><ArrowUp size={14}/>Earlier lines</button><button type="button" className="text-button" disabled={windowEnd>=data.lines.length} onClick={()=>setEnd(Math.min(data.lines.length,windowEnd+windowSize))}>Newer lines</button></div>:null}
  <pre className="execution-log execution-console-viewport" aria-label="Workflow run log" tabIndex={0} ref={viewport} onWheel={event=>{if(event.deltaY<0)stop();}} onKeyDown={event=>{if(['ArrowUp','PageUp','Home'].includes(event.key))stop();}} onScroll={event=>{const node=event.currentTarget;if(follow&&node.scrollHeight-node.scrollTop-node.clientHeight>32)stop();}}>{text?rows:<span className="execution-console-empty">No log output yet.</span>}</pre>
 </div>;
}
