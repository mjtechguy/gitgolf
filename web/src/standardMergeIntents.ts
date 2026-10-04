// Original merge identity only. No text, credentials or executable permit.
import {isCommitID,isRunID} from './navigation';
import {sourceRepositoryID} from './sourceReads';
export const standardMergeIntentPrefix='golf.standard-merge.v1:';
export const standardMergeIntentKey=(actor:string,repo:string,pull:string)=>`${standardMergeIntentPrefix}${location.origin}:${actor}:${repo}:${pull}`;
export type StandardMergeIntent={operationId:string;actorId:string;repository:{owner:string;name:string};repositoryId:string;ownerId:string;pullRequestId:string;number:number;expectedPullRevision:string;headCommitId:string;baseCommitId:string;sourceRef:string;targetRef:string};
export function clearOtherStandardMergeIntents(actor?:string){try{const keep=actor?`${standardMergeIntentPrefix}${location.origin}:${actor}:`:'';for(const key of Object.keys(sessionStorage))if(key.startsWith(standardMergeIntentPrefix)&&(!keep||!key.startsWith(keep)))sessionStorage.removeItem(key);}catch{/* Dispatch still requires writable storage. */}}
export function readStandardMergeIntent(key:string,actor:string,repository:{owner:string;name:string},repo:string,pull:string,number:number):StandardMergeIntent|null{
 const raw=sessionStorage.getItem(key);if(raw===null)return null;
 if(raw.length>16384)throw new Error('Saved original merge metadata is invalid. New merges are blocked.');
 const value=JSON.parse(raw) as StandardMergeIntent;
 const ref=(v:unknown)=>typeof v==='string'&&v.length>0&&new TextEncoder().encode(v).length<=4096&&!/[\p{Cc}\uD800-\uDFFF]/u.test(v);
 if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='actorId,baseCommitId,expectedPullRevision,headCommitId,number,operationId,ownerId,pullRequestId,repository,repositoryId,sourceRef,targetRef'||!value.repository||Object.keys(value.repository).sort().join(',')!=='name,owner'||value.repository.owner!==repository.owner||value.repository.name!==repository.name||!isRunID(value.operationId)||value.actorId!==actor||!sourceRepositoryID(actor)||value.repositoryId!==repo||!sourceRepositoryID(repo)||!sourceRepositoryID(value.ownerId)||value.pullRequestId!==pull||!sourceRepositoryID(pull)||value.number!==number||!Number.isInteger(number)||number<1||number>2147483647||!/^[a-f0-9]{64}$/.test(value.expectedPullRevision)||!isCommitID(value.headCommitId)||!isCommitID(value.baseCommitId)||value.headCommitId.length!==value.baseCommitId.length||!ref(value.sourceRef)||!ref(value.targetRef))throw new Error('Saved original merge metadata is invalid. New merges are blocked.');
 return value;
}
