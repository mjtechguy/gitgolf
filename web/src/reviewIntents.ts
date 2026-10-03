// Only request identity is retained in this tab. Review text stays in memory.
import { PullRequestReviewState } from './gen/golf/v1/golf_pb';
export type ReviewIntent = { key:string; repositoryId:string; pullRequestId:string; number:number; headCommitId:string; state:PullRequestReviewState };
const prefix='golf.review-intent.';
const validID=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
export const reviewIntentKey=(userId:string,repositoryId:string,pullRequestId:string)=>`${prefix}${window.location.origin}:${userId}:${repositoryId}:${pullRequestId}`;
export function clearOtherReviewIntents(userId?:string){
 try{const keep=userId?`${prefix}${window.location.origin}:${userId}:`:undefined;for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix)&&(!keep||!key.startsWith(keep)))sessionStorage.removeItem(key);}catch{/* A request still requires writable storage before dispatch. */}
}
export function readReviewIntent(storageKey:string,repositoryId:string,pullRequestId:string,number:number):ReviewIntent|null{
 try{const v:unknown=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(v&&typeof v==='object'&&'key'in v&&typeof v.key==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.key)&&'repositoryId'in v&&v.repositoryId===repositoryId&&validID(repositoryId)&&'pullRequestId'in v&&v.pullRequestId===pullRequestId&&validID(pullRequestId)&&'number'in v&&v.number===number&&Number.isInteger(number)&&number>0&&'headCommitId'in v&&typeof v.headCommitId==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v.headCommitId)&&'state'in v&&[PullRequestReviewState.COMMENT,PullRequestReviewState.APPROVED,PullRequestReviewState.REQUEST_CHANGES].includes(v.state as PullRequestReviewState))return{key:v.key,repositoryId,pullRequestId,number,headCommitId:v.headCommitId,state:v.state as PullRequestReviewState};}catch{/* Tab metadata never authorizes a review. */}return null;
}
