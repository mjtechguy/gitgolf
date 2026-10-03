import { parseDiff } from './diff';
import type { DiffCoordinate } from './DiffHunk';
import { PullReviewDraftSide, PullReviewDraftOperationKind } from './gen/golf/v1/golf_pb';
import type { PullReviewDraft, PullReviewDraftCapture, PullReviewDraftEntry, PullReviewDraftReceipt, PullReviewDraftTarget } from './gen/golf/v1/golf_pb';

const int64Max=9223372036854775807n;
export const draftUUID=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const draftNumber=(value:string,zero=false)=>new RegExp(zero?'^(0|[1-9][0-9]{0,18})$':'^[1-9][0-9]{0,18}$').test(value)&&BigInt(value)<=int64Max;
const objectID=(value:string)=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export const draftText=(value:string,max=6000)=>new TextEncoder().encode(value).byteLength<=max&&new TextDecoder().decode(new TextEncoder().encode(value))===value&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
const draftDate=(value:string)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const safePath=(value:string)=>Boolean(value)&&draftText(value,4096)&&!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\r\n\t]/.test(value);
export const draftCoordinateEqual=(a:DiffCoordinate,b:DiffCoordinate)=>a.fileIndex===b.fileIndex&&a.hunkIndex===b.hunkIndex&&a.side===b.side&&a.line===b.line&&a.path===b.path;
export function entryCoordinate(entry:PullReviewDraftEntry):DiffCoordinate|undefined {
 const c=entry.coordinate;
 return c&&(c.side===PullReviewDraftSide.OLD||c.side===PullReviewDraftSide.NEW)?{fileIndex:c.fileIndex,hunkIndex:c.hunkIndex,side:c.side===PullReviewDraftSide.OLD?'old':'new',line:c.line,path:c.path}:undefined;
}
export type DraftIntent={operationId:string;draftId:string;kind:'save'|'delete';expectedVersion:string;expectedTargetGeneration:string;comparisonId:string};
export const draftIntentKey=(user:string,repo:string,pull:string)=>`golf.private-review-draft.v1:${user}:${repo}:${pull}`;
export function readDraftIntent(key:string):DraftIntent|null {
 try {const v:unknown=JSON.parse(sessionStorage.getItem(key)||'null');if(!v||typeof v!=='object')return null;const r=v as Record<string,unknown>;if(Object.keys(r).sort().join(',')!=='comparisonId,draftId,expectedTargetGeneration,expectedVersion,kind,operationId'||typeof r.operationId!=='string'||!draftUUID(r.operationId)||typeof r.draftId!=='string'||!draftUUID(r.draftId)||!['save','delete'].includes(String(r.kind))||typeof r.expectedVersion!=='string'||!draftNumber(r.expectedVersion,true)||typeof r.expectedTargetGeneration!=='string'||!draftNumber(r.expectedTargetGeneration,true)||typeof r.comparisonId!=='string'||r.comparisonId!==''&&!draftUUID(r.comparisonId)||r.kind==='delete'&&(r.expectedVersion==='0'||!r.comparisonId))return null;return r as DraftIntent;}catch{return null;}
}
export function sameDraftTarget(v:Pick<PullReviewDraftTarget,'repositoryId'|'pullRequestId'|'number'>|undefined,expected:Pick<PullReviewDraftTarget,'repositoryId'|'pullRequestId'|'number'>){return Boolean(v&&draftNumber(v.repositoryId)&&draftNumber(v.pullRequestId)&&v.repositoryId===expected.repositoryId&&v.pullRequestId===expected.pullRequestId&&v.number===expected.number&&Number.isInteger(v.number)&&v.number>0&&v.number<=2147483647);}
export function validateDraftCapture(c:PullReviewDraftCapture|undefined,target:PullReviewDraftTarget){
 const s=c?.selection;
 if(!c||!s||!sameDraftTarget(s,target)||!s.repository?.owner||!s.repository.name||!objectID(s.baseCommitId)||!objectID(s.headCommitId)||!objectID(c.mergeBaseCommitId)||s.baseCommitId.length!==s.headCommitId.length||c.mergeBaseCommitId.length!==s.headCommitId.length||!(/^[a-f0-9]{64}$/).test(c.expectedPullRevision)||!(/^[a-f0-9]{64}$/).test(c.diffSha256))throw new Error('The private draft comparison does not match this target.');
}
export async function draftSHA(text:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function validateDraft(v:PullReviewDraft,target:PullReviewDraftTarget,userId:string){
 const c=v.comparison;
 if(!draftUUID(v.id)||v.userId!==userId||!sameDraftTarget(v.target,target)||v.target?.repository?.owner!==target.repository?.owner||v.target?.repository?.name!==target.repository?.name||!draftNumber(v.version)||!c||!draftUUID(c.id)||!c.parserVersion||c.parserVersion.length>128||!draftDate(v.createdAt)||!draftDate(v.updatedAt))throw new Error('The private draft owner, target or version could not be verified.');
 validateDraftCapture(c.capture,target);
 if(c.byteSize>512*1024||new TextEncoder().encode(c.rawDiff).byteLength!==c.byteSize||await draftSHA(c.rawDiff)!==c.capture!.diffSha256)throw new Error('The private draft source does not match its retained comparison.');
 validateDraftEntries(v.summary,v.entries,c.rawDiff);
}
export function validateDraftEntries(summary:string,entries:PullReviewDraftEntry[],text:string){
 const parsed=parseDiff(text);const ids=new Set<string>(),coordinates=new Set<string>();let size=new TextEncoder().encode(summary).byteLength;
 if(!draftText(summary)||entries.length>20)throw new Error('Use a summary up to 6,000 UTF-8 bytes and at most 20 private comments.');
 for(const entry of entries){const c=entryCoordinate(entry);if(!draftUUID(entry.id)||ids.has(entry.id)||!c||!safePath(c.path)||!draftText(entry.body)||!entry.body.trim()||!Number.isInteger(c.line)||c.line<1||c.line>2147483647||!Number.isInteger(c.fileIndex)||!Number.isInteger(c.hunkIndex))throw new Error('The private draft contains an invalid comment.');ids.add(entry.id);const file=parsed.files[c.fileIndex],hunk=file?.hunks[c.hunkIndex],path=c.side==='old'?file?.oldPath:file?.path;const matches=hunk?.lines.filter(line=>line.kind!=='notice'&&(c.side==='old'?line.old:line.next)===c.line).length;const key=`${c.fileIndex}:${c.hunkIndex}:${c.side}:${c.line}`;if(!file?.valid||file.binary||path!==c.path||matches!==1||coordinates.has(key))throw new Error('A private comment does not match one exact original file line.');coordinates.add(key);size+=new TextEncoder().encode(entry.body+c.path).byteLength;}
 if(size>256*1024)throw new Error('Private draft content exceeds 256 KiB.');
}
export function validateDraftReceipt(receipt:PullReviewDraftReceipt|undefined,intent:DraftIntent,target:PullReviewDraftTarget){
 if(!receipt||receipt.operationId!==intent.operationId||receipt.draftId!==intent.draftId||!sameDraftTarget(receipt.target,target)||!receipt.target?.repository?.owner||!receipt.target.repository.name||receipt.kind!==(intent.kind==='save'?PullReviewDraftOperationKind.SAVE:PullReviewDraftOperationKind.DELETE)||receipt.expectedVersion!==intent.expectedVersion||!draftNumber(receipt.acceptedVersion)||BigInt(receipt.acceptedVersion)!==BigInt(intent.expectedVersion)+1n||!draftUUID(receipt.comparisonId)||intent.comparisonId&&receipt.comparisonId!==intent.comparisonId||receipt.expectedTargetGeneration!==intent.expectedTargetGeneration||!draftNumber(receipt.acceptedTargetGeneration)||BigInt(receipt.acceptedTargetGeneration)!==BigInt(intent.expectedTargetGeneration)+1n)throw new Error('The private draft receipt does not match this operation. Keep its ID and check status.');
}
