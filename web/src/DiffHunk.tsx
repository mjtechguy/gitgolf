import { Fragment, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { splitLines, type DiffLine } from './diff';

export type DiffCoordinate={fileIndex:number;hunkIndex:number;side:'old'|'new';line:number;path:string};
export type DiffLineActions={onLineAction?:(coordinate:DiffCoordinate)=>void;lineActionLabel?:(coordinate:DiffCoordinate)=>string;lineActionAllowed?:(coordinate:DiffCoordinate)=>boolean;renderLineAnnotation?:(coordinate:DiffCoordinate)=>ReactNode};
function coordinate(line:DiffLine|undefined,side:'old'|'new',props:HunkProps):DiffCoordinate|undefined {
 const number=side==='old'?line?.old:line?.next;
 const path=side==='old'?props.oldPath:props.path;
 return number!==undefined&&Number.isInteger(number)&&number>0&&number<=2147483647&&path&&props.fileIndex!==undefined&&props.hunkIndex!==undefined?{fileIndex:props.fileIndex,hunkIndex:props.hunkIndex,side,line:number,path}:undefined;
}
function LineNumber({number,id,selection,actions}:{number?:number;id:string;selection?:DiffCoordinate;actions:DiffLineActions}) {
 const actionable=selection&&actions.onLineAction&&(!actions.lineActionAllowed||actions.lineActionAllowed(selection));
 return <td className={`diff-line-number ${actionable?'with-line-action':''}`}>{number!==undefined?<><a id={id} href={`#${id}`} aria-label={`Line ${number}`}>{number}</a>{actionable?<button type="button" className="diff-line-action" aria-label={actions.lineActionLabel?.(selection)||`Add comment on ${selection.side} line ${number} in ${selection.path}`} title={actions.lineActionLabel?.(selection)||`Add comment · ${selection.side} line ${number}`} onClick={()=>actions.onLineAction?.(selection)}><Plus size={13} aria-hidden="true"/></button>:null}</>:null}</td>;
}
function SplitCell({line,id,side,tokens,props}:{line?:DiffLine;id:string;side:'old'|'new';tokens?:Map<DiffLine,ReactNode>;props:HunkProps}) {
 return <><LineNumber number={side==='old'?line?.old:line?.next} id={id} selection={coordinate(line,side,props)} actions={props}/><td className={`diff-code ${line?.kind||'empty'}`}><code>{line?(tokens?.get(line)??line.text):''}</code></td></>;
}
function Annotations({oldLine,newLine,props}:{oldLine?:DiffLine;newLine?:DiffLine;props:HunkProps}) {
 if(!props.renderLineAnnotation)return null;
 const old=coordinate(oldLine,'old',props),next=coordinate(newLine,'new',props);
 const oldContent=old?props.renderLineAnnotation(old):null,newContent=next?props.renderLineAnnotation(next):null;
 return oldContent||newContent?<tr className="diff-annotation-row"><td colSpan={props.split?4:3}>{oldContent}{newContent}</td></tr>:null;
}
export type DiffTokens={old:Map<DiffLine,ReactNode>;new:Map<DiffLine,ReactNode>};
export type HunkProps={lines:DiffLine[];header:string;id:string;split:boolean;fileIndex?:number;hunkIndex?:number;path?:string;oldPath?:string}&DiffLineActions;
export function Hunk(props:HunkProps&{tokens?:DiffTokens}) {
 const {lines,header,id,split,tokens}=props;
 return <><tr className="diff-hunk"><td colSpan={split?4:3}><code>{header}</code></td></tr>{split?splitLines(lines).map((row,index)=><Fragment key={index}><tr><SplitCell line={row.left} side="old" id={`${id}-L${row.left?.old??`note${index}`}`} tokens={tokens?.old} props={props}/><SplitCell line={row.right} side="new" id={`${id}-R${row.right?.next??`note${index}`}`} tokens={tokens?.new} props={props}/></tr><Annotations oldLine={row.left} newLine={row.right} props={props}/></Fragment>):lines.map((line,index)=><Fragment key={index}><tr className={line.kind}><LineNumber number={line.old} id={`${id}-L${line.old}`} selection={coordinate(line,'old',props)} actions={props}/><LineNumber number={line.next} id={`${id}-R${line.next}`} selection={coordinate(line,'new',props)} actions={props}/><td className="diff-code"><span className="diff-sign" aria-hidden="true">{line.kind==='add'?'+':line.kind==='delete'?'−':' '}</span><code>{(line.kind==='delete'?tokens?.old:tokens?.new)?.get(line)??line.text}</code></td></tr><Annotations oldLine={line} newLine={line} props={props}/></Fragment>)}</>;
}
