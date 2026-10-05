import {useId,useLayoutEffect,useRef,useState} from 'react';
import {ArrowDownToLine,ChevronDown,ChevronUp,Download,Maximize,Minimize,Search} from 'lucide-react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {SearchAddon} from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
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
const scrollback=10000;
const decorations={matchBackground:'#514320',activeMatchBackground:'#755d25',matchOverviewRuler:'#efd37b',activeMatchColorOverviewRuler:'#fff0b0'};

// The parent supplies validated authorized bytes. A scope/authority change
// disposes the terminal and its pending writes; refresh alone preserves it.
export function WorkflowLogConsole(props:WorkflowLogConsoleProps) {
 return props.authorized?<Console key={props.scopeKey} {...props}/>:null;
}
function Console({text,status,fileName,refreshing=false}:WorkflowLogConsoleProps) {
 const wrapper=useRef<HTMLDivElement>(null),host=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),finder=useRef<SearchAddon|null>(null),lastText=useRef(''),followRef=useRef(true),searchRef=useRef(''),alive=useRef(false);
 const id=useId();const [follow,setFollow]=useState(true),[search,setSearch]=useState(''),[searchOpen,setSearchOpen]=useState(false),[result,setResult]=useState({resultIndex:-1,resultCount:0}),[fullscreen,setFullscreen]=useState(false),[notice,setNotice]=useState('');
 function following(value:boolean){followRef.current=value;setFollow(value);}
 useLayoutEffect(()=>{
  alive.current=true;
  const style=getComputedStyle(host.current!);
  const color=(name:string,fallback:string)=>style.getPropertyValue('--terminal-'+name).trim()||fallback;
  const term=new Terminal({disableStdin:true,convertEol:true,scrollback,fontFamily:'"Geist Mono", monospace',fontSize:14,lineHeight:1,cursorBlink:false,screenReaderMode:true,scrollOnUserInput:false,allowProposedApi:true,
   theme:{background:color('bg','#080808'),foreground:color('fg','#ececec'),cursor:color('fg','#ececec'),selectionBackground:color('selection','#454545'),selectionForeground:color('fg','#ececec'),black:color('black','#808080'),red:color('red','#ff9b9b'),green:color('green','#8cdb9f'),yellow:color('yellow','#efd37b'),blue:color('blue','#99caff'),magenta:color('magenta','#d6a9ed'),cyan:color('cyan','#8cddd8'),white:color('white','#ececec'),brightBlack:color('bright-black','#a3a3a3'),brightRed:color('bright-red','#ffb5b5'),brightGreen:color('bright-green','#a4e5b4'),brightYellow:color('bright-yellow','#f7e39c'),brightBlue:color('bright-blue','#b4d9ff'),brightMagenta:color('bright-magenta','#e4c4f3'),brightCyan:color('bright-cyan','#a5e9e5'),brightWhite:color('bright-white','#ffffff')},
   linkHandler:{activate:()=>{},hover:()=>{}}});
  // Swallow browser-affecting OSC handlers. Native VT parsing retains partial
  // escape sequences across writes; no ad-hoc ANSI sanitizer or link addon.
  const guards=[0,1,2,8,52].map(code=>term.parser.registerOscHandler(code,()=>true));
  const fit=new FitAddon(),addon=new SearchAddon({highlightLimit:200});term.loadAddon(fit);term.loadAddon(addon);terminal.current=term;finder.current=addon;
  const results=addon.onDidChangeResults(value=>{if(alive.current)setResult(value);});
  const scrolling=term.onScroll(y=>{if(followRef.current&&y<term.buffer.active.baseY)following(false);});
  const wheelToPage=(event:WheelEvent)=>{
   if(event.ctrlKey||event.metaKey||event.shiftKey)return true;
   if(document.fullscreenElement===wrapper.current)return false;
   const buffer=term.buffer.active;
   return event.deltaY<0?buffer.viewportY===0:event.deltaY>0?buffer.viewportY===buffer.baseY:true;
  };
  term.attachCustomWheelEventHandler(event=>!wheelToPage(event));
  // The child viewport can consume a wheel before the public terminal hook,
  // even at a rounded buffer boundary. Skip only that handler; the browser
  // performs normal page scrolling/zoom, without cancelling its default.
  const pageWheel=(event:WheelEvent)=>{if(wheelToPage(event))event.stopPropagation();};
  host.current!.addEventListener('wheel',pageWheel,{capture:true});
  term.attachCustomKeyEventHandler(event=>{
   if(event.type==='keydown'&&['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(event.key)){
    following(false);if(event.key==='Home')term.scrollToTop();else if(event.key==='End')term.scrollToBottom();else if(event.key.startsWith('Page'))term.scrollPages(event.key==='PageUp'?-1:1);else term.scrollLines(event.key==='ArrowUp'?-1:1);event.preventDefault();return false;
   }
   return true;
  });
  const resize=()=>{if(alive.current&&terminal.current===term&&term.element&&host.current?.clientWidth&&host.current.clientHeight){fit.fit();if(followRef.current)term.scrollToBottom();}};
  const observer=new ResizeObserver(resize);observer.observe(host.current!);
  // Measure with the actual font before opening; stale async font completions
  // cannot open a disposed terminal after an authority/scope transition.
  void document.fonts.load('14px "Geist Mono"').catch(()=>[]).then(()=>document.fonts.ready).then(()=>{if(!alive.current||terminal.current!==term)return;term.open(host.current!);term.textarea?.setAttribute('aria-label','Read-only workflow terminal');term.textarea?.setAttribute('readonly','');resize();if(searchRef.current)addon.findNext(searchRef.current,{incremental:true,decorations});});
  const changed=()=>{if(alive.current){setFullscreen(document.fullscreenElement===wrapper.current);resize();}};document.addEventListener('fullscreenchange',changed);
  return()=>{alive.current=false;host.current?.removeEventListener('wheel',pageWheel,{capture:true});observer.disconnect();document.removeEventListener('fullscreenchange',changed);scrolling.dispose();results.dispose();guards.forEach(guard=>guard.dispose());finder.current=null;terminal.current=null;lastText.current='';term.dispose();};
 },[]);
 useLayoutEffect(()=>{
  const term=terminal.current;if(!term)return;
  const previous=lastText.current,append=text.startsWith(previous),chunk=append?text.slice(previous.length):text;
  if(append&&!chunk)return;
  const position=term.buffer.active.viewportY;
  if(!append){term.reset();finder.current?.clearDecorations();}
  lastText.current=text;
  term.write(chunk,()=>{
   if(!alive.current||terminal.current!==term)return;
   if(followRef.current)term.scrollToBottom();else term.scrollToLine(position);
   if(term.element&&searchRef.current)finder.current?.findNext(searchRef.current,{incremental:true,decorations});
  });
 },[text]);
 function find(value:string,previous=false){searchRef.current=value;setSearch(value);if(!value){finder.current?.clearDecorations();terminal.current?.clearSelection();setResult({resultIndex:-1,resultCount:0});return;}following(false);if(!terminal.current?.element)return;if(previous)finder.current?.findPrevious(value,{decorations});else finder.current?.findNext(value,{decorations});}
 async function expand(){setNotice('');try{if(document.fullscreenElement===wrapper.current)await document.exitFullscreen();else if(wrapper.current?.requestFullscreen)await wrapper.current.requestFullscreen();else setNotice('Fullscreen is unavailable in this browser.');}catch{if(alive.current)setNotice('Fullscreen is unavailable in this browser.');}}
 const name=fileName.replace(/[^A-Za-z0-9._-]/g,'-').slice(0,180)||'golf-run.log';
 return <div className="execution-console" ref={wrapper}>
  <div className="execution-console-toolbar">
   <div className="search-input" data-open={searchOpen} id={id+'-controls'}><label className="sr-only" htmlFor={id}>Search terminal scrollback</label><Search size={16} aria-hidden="true"/><input id={id} type="search" placeholder="Search terminal scrollback…" value={search} onChange={event=>find(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();find(search,event.shiftKey);}}} maxLength={256}/></div>
   <div className="row-actions"><button type="button" className="icon-button workflow-log-search-toggle" aria-label="Search terminal scrollback" title="Search terminal scrollback" aria-expanded={searchOpen} aria-controls={id+'-controls'} onClick={()=>setSearchOpen(value=>!value)}><Search size={16}/></button>{search?<><button type="button" className="icon-button" aria-label="Previous log match" title="Previous log match" disabled={!search} onClick={()=>find(search,true)}><ChevronUp size={16}/></button><button type="button" className="icon-button" aria-label="Next log match" title="Next log match" disabled={!search} onClick={()=>find(search)}><ChevronDown size={16}/></button></>:null}<CopyButton text={text} label="Copy loaded log"/><button type="button" className="icon-button" aria-label="Download loaded log" title="Download loaded log" disabled={!text} onClick={()=>downloadText(text,name)}><Download size={16}/></button><button type="button" className="icon-button" aria-label={fullscreen?'Exit terminal fullscreen':'Expand terminal'} title={fullscreen?'Exit terminal fullscreen':'Expand terminal'} onClick={()=>void expand()}>{fullscreen?<Minimize size={16}/>:<Maximize size={16}/>}</button><button type="button" className="button secondary" aria-label="Follow output" title="Follow output" aria-pressed={follow} onClick={()=>{const value=!followRef.current;following(value);if(value)terminal.current?.scrollToBottom();}}><ArrowDownToLine size={16}/><span className="workflow-log-follow-label">Follow</span></button></div>
  </div>
  <div className="execution-console-status" role="status"><span>{status==='streaming'?'Live output':status==='reconnecting'?'Reconnecting…':'Loaded output'}{refreshing?' · Loading…':''}</span><span>{notice|| (search?`${result.resultCount} match${result.resultCount===1?'':'es'} in terminal scrollback${result.resultIndex>=0?' · '+(result.resultIndex+1):''}`:'')}</span></div>
  <div className="execution-terminal-host" aria-label="Workflow run log" ref={host}/>
 </div>;
}
