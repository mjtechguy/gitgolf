import {memo,useEffect,useMemo,useRef} from 'react';
import {highlightedLines} from './SyntaxTokens';
import {useFragment} from './RepositoryUI';

export function sourceSelection(fragment:string,count:number) {
 const match=/^#L([1-9][0-9]{0,6})(?:-L([1-9][0-9]{0,6}))?$/.exec(fragment);
 if(!match)return undefined;
 const first=Number(match[1]),last=Number(match[2]||match[1]);
 return first<=last&&last<=count?{first,last}:undefined;
}
export default memo(function SourceCode({text,language,label}:{text:string;language:string;label:string}) {
 const anchor=useRef<number|undefined>(undefined);
 const fragment=useFragment();const lines=useMemo(()=>highlightedLines(text.replace(/\r\n/g,'\n'),language),[text,language]);
 // A terminal newline terminates the last line; it does not add an extra one.
 const shown=text.endsWith('\n')?lines.slice(0,-1):lines;
 const selection=sourceSelection(fragment,shown.length);
 useEffect(()=>{if(selection)document.getElementById('L'+selection.first)?.scrollIntoView({block:'nearest'});},[selection?.first,selection?.last]);
 return <div className="source-preview numbered-source" tabIndex={0} aria-label={label}><table role="presentation"><tbody>{shown.map((tokens,index)=>{
  const number=index+1,selected=Boolean(selection&&number>=selection.first&&number<=selection.last);
  return <tr key={number} id={`L${number}`} className={selected?'source-line-selected':undefined}><td className="source-line-number"><a href={`#L${number}`} aria-label={`Line ${number}`} aria-current={selected?'location':undefined} onClick={event=>{if(event.metaKey||event.ctrlKey||event.altKey)return;event.preventDefault();const origin=event.shiftKey?anchor.current??selection?.first??number:number;if(!event.shiftKey)anchor.current=number;const first=Math.min(origin,number),last=Math.max(origin,number);window.location.hash=`L${first}${last===first?'':'-L'+last}`;}}>{number}</a></td><td className="source-code-text"><code>{tokens.length?tokens:'\u200b'}</code></td></tr>;
 })}</tbody></table></div>;
});
