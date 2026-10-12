import { Fault, deny, invalid } from './common.mjs';
import { sha } from './git.mjs';
import { comparison, changedFiles } from './repository-diff.mjs';
import { pullReviewContext } from './collaboration.mjs';
import { confirmReviewAuthority } from './pull-reviews.mjs';

// Bounded glob matching avoids evaluating repository-supplied regular expressions.
function segment(pattern,value) {
 let p=0,v=0,star=-1,retry=0;
 while(v<value.length) {
  if(pattern[p]==='?'||pattern[p]===value[v]) {p++;v++;}
  else if(pattern[p]==='*') {star=p++;retry=v;}
  else if(star>=0) {p=star+1;v=++retry;}
  else return false;
 }
 while(pattern[p]==='*') p++;
 return p===pattern.length;
}
function matches(pattern,path) {
 const root=pattern.startsWith('/'),directory=pattern.endsWith('/');
 const parts=pattern.replace(/^\//,'').replace(/\/$/,'').split('/'),names=path.split('/');
 const prefix=directory||!/[?*]/.test(parts.at(-1));
 const starts=!root&&parts.length===1?names.map((_,i)=>i):[0];
 for(const start of starts) {
  let positions=new Set([start]);
  for(const part of parts) {
   const next=new Set();
   for(const index of positions) {
    if(part==='**') {for(let j=index;j<=names.length;j++) next.add(j);}
    else if(index<names.length&&segment(part,names[index])) next.add(index+1);
   }
   positions=next;
  }
  if(positions.has(names.length)&&!directory||prefix&&[...positions].some(i=>i<names.length)) return true;
 }
 return false;
}
export function codeOwnerSuggestions(source,paths) {
 if(new TextEncoder().encode(source).length>16384||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(source)) return {matches:[],routingComplete:false,unsupportedRules:1};
 const rules=[];let unsupportedRules=0;
 for(const line of source.split(/\r?\n/)) {
  const content=line.split('#')[0].trim();if(!content) continue;
  const [pattern,...owners]=content.split(/\s+/);
  if(rules.length>=200||pattern.length>256||/[!\[\]\\]/.test(pattern)||pattern.includes('//')||pattern.replace(/^\//,'').replace(/\/$/,'').split('/').some(p=>!p||p==='.'||p==='..'||p.includes('**')&&p!=='**')||owners.length>20||owners.some(o=>!/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(o))) {unsupportedRules++;continue;}
  rules.push({pattern,owners:[...new Set(owners)]});
 }
 if(unsupportedRules) return {matches:[],routingComplete:false,unsupportedRules};
 return {matches:paths.flatMap(path=>{let owners=[];for(const rule of rules) if(matches(rule.pattern,path)) owners=rule.owners;return owners.length?[{path,owners}]:[];}),routingComplete:true,unsupportedRules:0};
}
async function sourceFile(repo,base) {
 const commit=await repo.readCommit(base);if(!commit||!sha(commit.treeHash)) deny();
 for(const path of ['.github/CODEOWNERS','CODEOWNERS','docs/CODEOWNERS']) {
  let tree=commit.treeHash,entry;
  const parts=path.split('/');
  for(let i=0;i<parts.length;i++) {
   const entries=await repo.readTree(tree);if(!Array.isArray(entries)||entries.length>10000) throw new Fault('resource_exhausted',429,'CODEOWNERS directory exceeds its native read limit.');
   entry=entries.find(e=>e.name===parts[i]);if(!entry) break;
   if(!sha(entry.hash)) throw Error('Invalid CODEOWNERS tree');
   if(i<parts.length-1) {if(entry.type!=='tree') {entry=undefined;break;}tree=entry.hash;}
  }
  if(!entry) continue;
  if(!['blob','exec'].includes(entry.type)) throw new Fault('failed_precondition',412,'CODEOWNERS must be a regular file.');
  const blob=await repo.readBlob(entry.hash);
  if(!blob||!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>16384) throw new Fault('resource_exhausted',429,'Native CODEOWNERS files are limited to 16 KiB.');
  const bytes=await blob.arrayBuffer();if(bytes.byteLength!==blob.size) throw Error('Invalid CODEOWNERS blob size');
  let source;try {source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {invalid('CODEOWNERS must be UTF-8 text.');}
  return {path,blobId:entry.hash,source};
 }
 return {path:'',blobId:'',source:''};
}
export async function pullCodeOwners(db,env,person,row,body,artifact) {
 const selection=body.selection;
 if(!selection||!sha(selection.baseCommitId)||!sha(selection.headCommitId)) invalid('Use the exact displayed pull request comparison.');
 const {current}=await pullReviewContext(db,env,person,row,selection,artifact);
 if(current.revision!==body.expectedPullRevision||current.base.commitId!==selection.baseCommitId||current.head.commitId!==selection.headCommitId||current.base.retainedSnapshot||current.head.retainedSnapshot) throw new Fault('failed_precondition',412,'The selected pull request source changed.');
 const result=await artifact(async repo=>{
  const file=await sourceFile(repo,selection.baseCommitId);
  if(!file.path) return {...file,matches:[],routingComplete:true,unsupportedRules:0};
  const {mergeBase}=await comparison(repo,selection.baseCommitId,selection.headCommitId);
  const files=await changedFiles(repo,mergeBase,selection.headCommitId);
  return {...file,...codeOwnerSuggestions(file.source,files.map(f=>f.file))};
 });
 await confirmReviewAuthority(db,person,row);
 return {selection,pullRevision:current.revision,...result};
}
