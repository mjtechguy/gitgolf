import { useEffect, useMemo, useRef } from 'react';
import { Check, ChevronRight, FileDiff, Folder } from 'lucide-react';
import type { DiffFile } from './diff';

export type DiffEntry = { file: DiffFile; index: number };
type Directory = { path: string; name: string; directories: Map<string, Directory>; files: DiffEntry[] };

function directory(path = '', name = ''): Directory { return { path, name, directories: new Map(), files: [] }; }
function fileTree(entries: DiffEntry[]) {
  const root = directory();
  for (const entry of entries) {
    const parts = entry.file.path.split('/'); let node = root;
    // Bound presentation nesting; the complete native name remains on its link.
    for (const part of parts.slice(0, Math.min(parts.length - 1, 32))) {
      let child = node.directories.get(part);
      if (!child) { child = directory(node.path + part + '/', part); node.directories.set(part, child); }
      node = child;
    }
    node.files.push(entry);
  }
  return root;
}
function Branch({ node, prefix, viewed, selected, onSelect }: { node: Directory; prefix: string; viewed: Set<number>; selected?: number; onSelect: (index: number) => void }) {
  const folders = [...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name));
  return <ul className="diff-tree">
    {folders.map(folder => {
      let child = folder, label = folder.name;
      while (!child.files.length && child.directories.size === 1) { child = [...child.directories.values()][0]!; label += '/' + child.name; }
      return <li key={'folder-' + folder.path}><details className="diff-directory" open><summary aria-label={`Folder ${child.path.slice(0, -1)}`} title={child.path.slice(0, -1)}><ChevronRight size={14}/><Folder size={15}/><span>{label || '(empty directory name)'}</span></summary><Branch node={child} prefix={prefix} viewed={viewed} selected={selected} onSelect={onSelect}/></details></li>;
    })}
    {[...node.files].sort((a,b)=>a.file.path.localeCompare(b.file.path)).map(({file,index})=><li key={index}><a href={`#${prefix}-file-${index}`} aria-label={file.path} aria-current={selected===index?'location':undefined} title={file.path} onClick={()=>onSelect(index)}>{viewed.has(index)?<Check size={15}/>:<FileDiff size={15}/>}<span>{file.path.slice(node.path.length) || file.path}</span></a></li>)}
  </ul>;
}

// Ordinary navigation/disclosures retain native Tab/Enter/Space behavior.
export function DiffNavigation({ entries, prefix, viewed, selected, onSelect }: { entries: DiffEntry[]; prefix: string; viewed: Set<number>; selected?: number; onSelect: (index: number) => void }) {
  const tree = useMemo(()=>fileTree(entries),[entries]);
  const nav = useRef<HTMLElement>(null);
  useEffect(()=>{
    const host=nav.current, active=host?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!host || !active) return;
    for (let ancestor=active.parentElement; ancestor && ancestor!==host; ancestor=ancestor.parentElement) if (ancestor instanceof HTMLDetailsElement) ancestor.open=true;
    const bounds=host.getBoundingClientRect(), row=active.getBoundingClientRect();
    if(row.top<bounds.top)host.scrollTop+=row.top-bounds.top;
    else if(row.bottom>bounds.bottom)host.scrollTop+=row.bottom-bounds.bottom;
  },[tree,selected]);
  return <nav ref={nav} aria-label="Changed file navigation"><Branch node={tree} prefix={prefix} viewed={viewed} selected={selected} onSelect={onSelect}/></nav>;
}
