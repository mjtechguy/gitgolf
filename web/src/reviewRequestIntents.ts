export const reviewRequestIntentPrefix='golf.review-request.v1:';
export const reviewCommentIntentPrefix='golf.review-comment-interaction.v1:';
export const reviewLifecycleIntentPrefix='golf.review-lifecycle.v1:';
export function clearOtherReviewRequestIntents(userId?:string){try{for(const key of Object.keys(sessionStorage))if([reviewRequestIntentPrefix,reviewCommentIntentPrefix,reviewLifecycleIntentPrefix].some(prefix=>key.startsWith(prefix)&&(!userId||!key.startsWith(`${prefix}${userId}:`))))sessionStorage.removeItem(key);}catch{/* A new write requires readable and writable tab storage. */}}
