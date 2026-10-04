// Original-request metadata only. Names, credentials and RPC bodies never persist.
export type AccessIntent = {
  key: string; repositoryId: string; ownerId: string; recipientId: string;
  accessRevision: string; recipientRevision: string;
  permission: '' | 'read' | 'write' | 'admin'; remove: boolean;
};
const prefix = 'golf.access-intent.';
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const accessIntentKey = (user: string, repo: string, recipient: string) => `${prefix}${location.origin}:${user}:${repo}:${recipient}`;
function valid(value: unknown, repo: string, owner: string): value is AccessIntent {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 8 && uuid(r.key) && r.repositoryId === repo && r.ownerId === owner && id(r.repositoryId) && id(r.ownerId) && id(r.recipientId) && revision(r.accessRevision) && revision(r.recipientRevision) && ['', 'read', 'write', 'admin'].includes(r.permission as string) && typeof r.remove === 'boolean' && r.remove === (r.permission === '');
}
export function clearOtherAccessIntents(user?: string) {
  try {
    const keep = user ? `${prefix}${location.origin}:${user}:` : '';
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix) && (!keep || !key.startsWith(keep))) sessionStorage.removeItem(key);
  } catch { /* Failure to read storage must never enable a mutation. */ }
}
export function readAccessIntents(user: string, repo: string, owner: string): AccessIntent[] {
  if (!id(user) || !id(repo) || !id(owner)) throw new Error('Original access operation metadata is unavailable.');
  const rows: AccessIntent[] = [];
  for (const key of Object.keys(sessionStorage)) {
    if (!key.startsWith(`${prefix}${location.origin}:${user}:${repo}:`)) continue;
    const value: unknown = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!valid(value, repo, owner) || key !== accessIntentKey(user, repo, value.recipientId) || rows.length >= 20) throw new Error('Original access operation metadata is unavailable.');
    rows.push(value);
  }
  return rows;
}
export function saveAccessIntent(user: string, value: AccessIntent): boolean {
  if (!id(user) || !valid(value, value.repositoryId, value.ownerId)) return false;
  try {
    const key = accessIntentKey(user, value.repositoryId, value.recipientId);
    if (sessionStorage.getItem(key) !== null) return false;
    const encoded = JSON.stringify(value);
    sessionStorage.setItem(key, encoded);
    return sessionStorage.getItem(key) === encoded;
  } catch { return false; }
}
export function forgetAccessIntent(user: string, value: AccessIntent) {
  try { sessionStorage.removeItem(accessIntentKey(user, value.repositoryId, value.recipientId)); } catch { /* No replacement write is authorized by this failure. */ }
}
