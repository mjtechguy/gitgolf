import type { DiffFile } from './diff';

export type DiffSelection = { fileIndex: number; side?: 'old' | 'new'; first?: number; last?: number };

// Links describe the displayed patch only; missing context is never inferred.
export function diffSelection(fragment: string, prefix: string, files: DiffFile[]): DiffSelection | undefined {
 const marker=`#${prefix}-file-`;
 if(!fragment.startsWith(marker))return undefined;
 const match=/^(0|[1-9][0-9]*)(?:-([LR])([1-9][0-9]{0,9})(?:-\2([1-9][0-9]{0,9}))?)?$/.exec(fragment.slice(marker.length));
 if(!match)return undefined;
 const fileIndex=Number(match[1]),file=files[fileIndex];
 if(!Number.isSafeInteger(fileIndex)||!file)return undefined;
 if(!match[2])return {fileIndex};
 const side=match[2]==='L'?'old':'new',first=Number(match[3]),last=Number(match[4]||match[3]);
 if(!file.valid||first>last||last>2147483647)return undefined;
 const key=side==='old'?'old':'next';
 const inRange=(number:number|undefined)=>number!==undefined&&number>=first&&number<=last;
 const numbers=file.hunks.flatMap(hunk=>hunk.lines.map(line=>line[key]).filter(inRange));const count=numbers.length;
 if(new Set(numbers).size!==count)return undefined;
 if(count!==last-first+1||!file.hunks.some(hunk=>hunk.lines.filter(line=>inRange(line[key])).length===count))return undefined;
 return {fileIndex,side,first,last};
}
