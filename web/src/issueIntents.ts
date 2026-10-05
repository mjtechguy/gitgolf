// Tab convenience data only. Private discussion text and credentials never go
// into storage; the server remains authoritative for every outcome lookup.
export type IssueIntent = { key: string; kind: 'issue' | 'comment' | 'update' | 'pull-update' | 'pull'; editField?: 'title' | 'body' | 'close' | 'reopen' | 'draft' | 'ready' | 'milestone'; repositoryId: string; issueId: string; pullRequestId?: string; number: number };
const prefix = 'golf.issue-intent.';
const validID = (value: string) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
export function issueIntentKey(userId: string, repositoryId: string, issueId = '') {
  return `${prefix}${window.location.origin}:${userId}:${repositoryId}:${issueId || 'new'}`;
}
export function clearOtherIssueIntents(userId?: string) {
  const keep = userId ? `${prefix}${window.location.origin}:${userId}:` : undefined;
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix) && (!keep || !key.startsWith(keep))) sessionStorage.removeItem(key);
  } catch { /* Submitting a write requires storage to succeed separately. */ }
}
export function readIssueIntent(storageKey: string, repositoryId: string, issueId = '', number = 0, kind: IssueIntent['kind'] = issueId ? 'comment' : 'issue', pullRequestId = ''): IssueIntent | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (value && typeof value === 'object' && 'key' in value && typeof value.key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.key) &&
      'repositoryId' in value && value.repositoryId === repositoryId && validID(repositoryId) &&
      'issueId' in value && value.issueId === issueId && (!issueId || validID(issueId)) &&
      'number' in value && value.number === number && 'kind' in value && value.kind === kind &&
      (kind !== 'update' || 'editField' in value && ['title','body','close','reopen','milestone'].includes(String(value.editField))) &&
      (kind !== 'pull-update' || !issueId && validID(pullRequestId) && 'pullRequestId' in value && value.pullRequestId === pullRequestId && 'editField' in value && ['title','body','close','reopen','draft','ready'].includes(String(value.editField)))) {
      return { key: value.key, kind, repositoryId, issueId, number, ...(kind === 'pull-update' ? {pullRequestId} : {}), ...(kind === 'update' || kind === 'pull-update' ? {editField: (value as unknown as {editField: IssueIntent['editField']}).editField} : {}) };
    }
  } catch { /* A tab record never authorizes a request or supplies private text. */ }
  return null;
}
