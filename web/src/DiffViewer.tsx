import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Columns2, FileDiff, List, Search } from 'lucide-react';
import { parseDiff, splitLines } from './diff';
import type { DiffFile, DiffLine } from './diff';
import { CopyButton } from './RepositoryUI';

function LineNumber({ number, id }: { number?: number; id: string }) {
  return <td className="diff-line-number">{number !== undefined ? <a id={id} href={`#${id}`} aria-label={`Line ${number}`}>{number}</a> : null}</td>;
}
function SplitCell({ line, id, side }: { line?: DiffLine; id: string; side: 'old' | 'new' }) {
  return <><LineNumber number={side === 'old' ? line?.old : line?.next} id={id}/><td className={`diff-code ${line?.kind || 'empty'}`}><code>{line?.text ?? ''}</code></td></>;
}
function FilePatch({ file, id, split }: { file: DiffFile; id: string; split: boolean }) {
  const rows = file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
  // Bounded previews never invent line positions for malformed or oversized patches.
  if (!file.valid || rows > 12_000) return <><p className="panel-footnote">{!file.valid ? 'This patch format cannot be mapped safely to line numbers.' : 'This large patch exceeds the structured preview limit.'} Native text is shown below.</p><pre className="source-preview" tabIndex={0}><code>{file.raw}</code></pre></>;
  return <>
    {file.headers.slice(1).filter(Boolean).length ? <details className="metadata-details diff-file-metadata"><summary>File metadata{file.oldPath && file.oldPath !== file.path ? ` · renamed from ${file.oldPath}` : ''}</summary>{file.headers.slice(1).filter(Boolean).map((header, index) => <div key={index}><code>{header}</code></div>)}</details> : null}
    {file.binary ? <p className="panel-footnote">Binary content changed. No text preview is available.</p> : null}
    {file.hunks.length ? <div className="diff-scroll" tabIndex={0} aria-label={`Changes in ${file.path}`}><table className={`diff-lines ${split ? 'split' : 'unified'}`}><tbody>
      {file.hunks.map((hunk, index) => <Hunk key={index} lines={hunk.lines} header={hunk.header} id={id} split={split}/>) }
    </tbody></table></div> : !file.binary ? <p className="panel-footnote">No supported text hunks in this file.</p> : null}
  </>;
}

function ChangedFile({file,id,split,viewed,onViewed}:{file:DiffFile;id:string;split:boolean;viewed:boolean;onViewed:(value:boolean)=>void}) {
  const [collapsed,setCollapsed]=useState(false);
  const expanded=!collapsed&&!viewed;
  return <section id={id} className="diff-file"><div className="diff-file-heading"><button className="diff-file-toggle" aria-expanded={expanded} aria-controls={`${id}-patch`} aria-label={`${expanded?'Collapse':'Expand'} ${file.path}`} onClick={()=>{if(viewed)onViewed(false);setCollapsed(expanded);}}>{expanded?<ChevronDown size={16}/>:<ChevronRight size={16}/>}<code title={file.path}>{file.path}</code></button><CopyButton text={file.path} label={`Copy path ${file.path}`}/><span className="diff-stats"><span className="diff-added">+{file.additions}</span><span className="diff-deleted">−{file.deletions}</span></span><label className="diff-viewed"><input type="checkbox" checked={viewed} onChange={(event)=>{onViewed(event.target.checked);setCollapsed(false);}}/>Viewed</label></div><div id={`${id}-patch`} hidden={!expanded}>{expanded?<FilePatch file={file} id={id} split={split}/>:null}</div></section>;
}
function Hunk({ lines, header, id, split }: { lines: DiffLine[]; header: string; id: string; split: boolean }) {
  return <><tr className="diff-hunk"><td colSpan={split ? 4 : 3}><code>{header}</code></td></tr>{split ? splitLines(lines).map((row, index) => <tr key={index}><SplitCell line={row.left} side="old" id={`${id}-L${row.left?.old ?? `note${index}`}`}/><SplitCell line={row.right} side="new" id={`${id}-R${row.right?.next ?? `note${index}`}`}/></tr>) : lines.map((line, index) => <tr key={index} className={line.kind}>
    <LineNumber number={line.old} id={`${id}-L${line.old}`}/><LineNumber number={line.next} id={`${id}-R${line.next}`}/><td className="diff-code"><span className="diff-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '}</span><code>{line.text}</code></td>
  </tr>)}</>;
}

// Parent keys this workspace by actor, repository and comparison identity.
// Viewed state is intentionally private, in-memory and discarded on unmount.
export function DiffViewer({ text, snapshotId }: { text: string; snapshotId: string }) {
  const prefix = `diff-${snapshotId.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const { files, preamble } = useMemo(() => parseDiff(text), [text]);
  const [split, setSplit] = useState(false);
  const [filter, setFilter] = useState('');
  const [viewed, setViewed] = useState<Set<number>>(() => new Set());
  if (files.length > 500 || files.reduce((count, file) => count + file.hunks.reduce((rows, hunk) => rows + hunk.lines.length, 0), 0) > 12_000) {
    return <section className="diff-workspace" aria-label="Changed files"><p className="panel-footnote">This comparison exceeds the structured preview limit of 500 files or 12,000 rows. The complete bounded native text remains available.</p><pre className="source-preview" tabIndex={0} aria-label="Unified diff, plain text"><code>{text}</code></pre></section>;
  }
  const shown = files.map((file, index) => ({ file, index })).filter(({ file }) => `${file.path}\n${file.oldPath}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="diff-workspace" aria-label="Changed files">
    <div className="diff-toolbar"><strong><FileDiff size={16}/>{files.length} changed {files.length === 1 ? 'file' : 'files'}</strong><span className="diff-stats"><span className="diff-added">+{files.reduce((sum, file) => sum + file.additions, 0)}</span><span className="diff-deleted">−{files.reduce((sum, file) => sum + file.deletions, 0)}</span></span><span className="muted">{viewed.size}/{files.length} viewed this session</span><div className="content-view-controls"><button className={`text-button ${!split ? 'active' : ''}`} aria-pressed={!split} onClick={() => setSplit(false)}><List size={15}/>Unified</button><button className={`text-button ${split ? 'active' : ''}`} aria-pressed={split} onClick={() => setSplit(true)}><Columns2 size={15}/>Split</button></div></div>
    <div className="diff-layout"><aside className="diff-files"><label className="diff-search"><Search size={15}/><input aria-label="Filter changed files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)}/></label><nav aria-label="Changed file navigation">{shown.map(({file,index}) => <a href={`#${prefix}-file-${index}`} key={index} title={file.path}>{viewed.has(index) ? <Check size={14}/> : <FileDiff size={14}/>}<span>{file.path}</span></a>)}</nav></aside><div className="diff-patches">
      {preamble ? <details className="diff-preamble"><summary>Native commit header</summary><pre>{preamble}</pre></details> : null}
      {shown.map(({file,index}) => <ChangedFile key={index} file={file} id={`${prefix}-file-${index}`} split={split} viewed={viewed.has(index)} onViewed={(value)=>setViewed((before)=>{const next=new Set(before);if(value)next.add(index);else next.delete(index);return next;})}/>)}
      {!shown.length ? <p className="empty-state">{files.length ? 'No files match this filter.' : 'No structured file changes in this output.'}</p> : null}
    </div></div>
    <details className="diff-raw" open={!files.length}><summary>Native diff text</summary><pre className="source-preview" tabIndex={0} aria-label="Unified diff, plain text"><code>{text}</code></pre></details>
  </section>;
}
