import { useMemo, type ReactNode } from 'react';
import { Hunk, type HunkProps } from './DiffHunk';
import { highlightedLines } from './SyntaxTokens';
import type { DiffLine } from './diff';

export default function DiffSyntax(props:HunkProps & {language:string}) {
 const tokens=useMemo(()=>{
  const result={old:new Map<DiffLine,ReactNode>(),new:new Map<DiffLine,ReactNode>()};
  for(const side of ['old','new'] as const) {
   const lines=props.lines.filter(line=>line.kind==='context'||line.kind===(side==='old'?'delete':'add'));
   const rendered=highlightedLines(lines.map(line=>line.text).join('\n'),props.language);
   if(rendered.length===lines.length)lines.forEach((line,index)=>result[side].set(line,rendered[index]));
  }
  return result;
 },[props.lines,props.language]);
 return <Hunk {...props} tokens={tokens}/>;
}
