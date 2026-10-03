import { useMemo, type ReactNode } from 'react';
import {common,createLowlight} from 'lowlight';
import type {RootContent} from 'hast';
const highlighter = createLowlight(common);
// Split highlighted spans at native newlines without changing displayed text.
// Diff sides are highlighted independently; missing source context stays unknown.
export function highlightedLines(text:string, language:string): ReactNode[][] {
 const plain=()=>text.split('\n').map(line=>[line]);
 if(text.length>65536 || !highlighter.registered(language))return plain();
 try {
  const result:ReactNode[][]=[[]];let visited=0;
  const visit=(values:RootContent[],classes:string[],depth:number)=>{
   if(depth>64)throw new Error('Token nesting exceeds display bounds');
   for(const n of values) {
    if(++visited>100000)throw new Error('Token count exceeds display bounds');
    if(n.type==='text')n.value.split('\n').forEach((part,index)=>{
     if(index)result.push([]);
     if(part) {const line=result[result.length-1]!;line.push(classes.length?<span key={line.length} className={classes.join(' ')}>{part}</span>:part);}
    });
    else if(n.type==='element')visit(n.children,[...classes,...(Array.isArray(n.properties.className)?n.properties.className.map(String):[])],depth+1);
   }
  };
  visit(highlighter.highlight(language,text).children,[],0);
  return result;
 } catch {return plain();}
}
function nodes(values: RootContent[]): ReactNode { return values.map((n,i) => n.type === 'text' ? n.value : n.type === 'element' ? <span key={i} className={Array.isArray(n.properties.className) ? n.properties.className.join(' ') : undefined}>{nodes(n.children)}</span> : null); }
export default function Tokens({ text, language }: { text: string; language: string }) {
 const value = useMemo(() => {
  if (text.length > 65536 || !highlighter.registered(language)) return text;
  try { return nodes(highlighter.highlight(language, text).children); } catch { return text; }
 }, [text, language]);
 return <>{value}</>;
}
