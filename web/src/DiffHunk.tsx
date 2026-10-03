import type { ReactNode } from 'react';
import { splitLines, type DiffLine } from './diff';

function LineNumber({ number, id }: { number?: number; id: string }) {
 return <td className="diff-line-number">{number!==undefined?<a id={id} href={`#${id}`} aria-label={`Line ${number}`}>{number}</a>:null}</td>;
}
function SplitCell({line,id,side,tokens}:{line?:DiffLine;id:string;side:'old'|'new';tokens?:Map<DiffLine,ReactNode>}) {
 return <><LineNumber number={side==='old'?line?.old:line?.next} id={id}/><td className={`diff-code ${line?.kind||'empty'}`}><code>{line?(tokens?.get(line)??line.text):''}</code></td></>;
}
export type DiffTokens={old:Map<DiffLine,ReactNode>;new:Map<DiffLine,ReactNode>};
export type HunkProps={lines:DiffLine[];header:string;id:string;split:boolean};
export function Hunk({lines,header,id,split,tokens}:{tokens?:DiffTokens} & HunkProps) {
 return <><tr className="diff-hunk"><td colSpan={split?4:3}><code>{header}</code></td></tr>{split?splitLines(lines).map((row,index)=><tr key={index}><SplitCell line={row.left} side="old" id={`${id}-L${row.left?.old??`note${index}`}`} tokens={tokens?.old}/><SplitCell line={row.right} side="new" id={`${id}-R${row.right?.next??`note${index}`}`} tokens={tokens?.new}/></tr>):lines.map((line,index)=><tr key={index} className={line.kind}><LineNumber number={line.old} id={`${id}-L${line.old}`}/><LineNumber number={line.next} id={`${id}-R${line.next}`}/><td className="diff-code"><span className="diff-sign" aria-hidden="true">{line.kind==='add'?'+':line.kind==='delete'?'−':' '}</span><code>{(line.kind==='delete'?tokens?.old:tokens?.new)?.get(line)??line.text}</code></td></tr>)}</>;
}
