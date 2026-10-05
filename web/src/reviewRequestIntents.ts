export const reviewRequestIntentPrefix='golf.review-request.v1:';
export function clearOtherReviewRequestIntents(userId?:string){try{for(const key of Object.keys(sessionStorage))if(key.startsWith(reviewRequestIntentPrefix)&&(!userId||!key.startsWith(`${reviewRequestIntentPrefix}${userId}:`)))sessionStorage.removeItem(key);}catch{/* A new write requires readable and writable tab storage. */}}
