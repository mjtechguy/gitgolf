// Cleanup is independent of the lazily loaded workflow editor. Metadata contains
// only the original request's identity; it never authorizes execution or replay.
export const workflowDispatchIntentPrefix = 'golf.workflow-dispatch.v1:';
export const workflowDispatchIntentKey = (actor:string,repository:string) => `${workflowDispatchIntentPrefix}${location.origin}:${actor}:${repository}`;
export function clearOtherWorkflowDispatchIntents(actor?:string) {
 try {
  const keep=actor?`${workflowDispatchIntentPrefix}${location.origin}:${actor}:`:'';
  for(const key of Object.keys(sessionStorage))if(key.startsWith(workflowDispatchIntentPrefix)&&(!keep||!key.startsWith(keep)))sessionStorage.removeItem(key);
 } catch { /* Unreadable storage must never enable a new dispatch. */ }
}
