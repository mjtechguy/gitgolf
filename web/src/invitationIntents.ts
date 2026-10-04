import { Code, ConnectError } from '@connectrpc/connect';
import type { RepositoryInvitation, RepositoryInvitationOperation } from './gen/golf/v1/golf_pb';
export const invitationID = (s: string) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
export const nativeID = (s: string) => typeof s === 'string' && /^[1-9][0-9]{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n;
export const accessRevision = (s: string) => /^[0-9a-f]{64}$/.test(s);
const date = (s: string) => Boolean(s && Number.isFinite(Date.parse(s)));
const login = (s: string) => Boolean(s && /^[A-Za-z0-9_.-]+$/.test(s));
export function validInvitation(i: RepositoryInvitation) {
 if (!invitationID(i.id) || !nativeID(i.revision) || !date(i.expiresAt) || !date(i.createdAt) || !['PENDING','GRANTING','ACCEPTED','REJECTED','REVOKED','EXPIRED'].includes(i.state)) return false;
 if (!i.detailsAvailable) return !i.repository && !i.issuer && !i.recipient && !i.repositoryId && !i.ownerId && !i.permission && !i.organizationOwned;
 return Boolean(i.repository && login(i.repository.owner) && login(i.repository.name) && nativeID(i.repositoryId) && nativeID(i.ownerId) && i.issuer && nativeID(i.issuer.id) && login(i.issuer.login) && i.recipient && nativeID(i.recipient.id) && login(i.recipient.login) && ['read','write','admin'].includes(i.permission));
}
export type InvitationIntent = { key: string; invitationId: string; revision: string; repositoryId: string; ownerId: string; recipientId: string; decision: number };
export function operationBound(o: RepositoryInvitationOperation | undefined, i: InvitationIntent) {
 if (!o || o.idempotencyKey !== i.key || o.invitationId !== i.invitationId || o.invitationRevision !== i.revision || o.repositoryId !== i.repositoryId || o.ownerId !== i.ownerId || o.recipientId !== i.recipientId || !['RESERVED','DISPATCH_UNKNOWN','SUCCEEDED','REJECTED'].includes(o.phase) || !date(o.createdAt) || !date(o.updatedAt) || (o.phase === 'REJECTED' ? o.failureCode !== 'preflight_refused' : Boolean(o.failureCode))) throw new ConnectError('The original invitation outcome could not be verified. Inspect it without resending.', Code.Internal);
 return o;
}
const prefix = 'golf.invitation-intent.';
export const invitationStorageKey = (userId: string, id: string) => `${prefix}${window.location.origin}:${userId}:${id}`;
export function readInvitationIntent(userId: string, id: string): InvitationIntent | null {
 try { const v = JSON.parse(sessionStorage.getItem(invitationStorageKey(userId,id)) || 'null') as InvitationIntent | null;
 if (v && invitationID(v.key) && v.invitationId === id && nativeID(v.revision) && nativeID(v.repositoryId) && nativeID(v.ownerId) && v.recipientId === userId && [1,2].includes(v.decision)) return v;
 } catch { /* Storage metadata is never authority. */ } return null;
}
export function saveInvitationIntent(userId: string, v: InvitationIntent) { sessionStorage.setItem(invitationStorageKey(userId,v.invitationId), JSON.stringify(v)); }
export function forgetOtherInvitationIntents(userId: string) {
 try { const keep = `${prefix}${window.location.origin}:${userId}:`; for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix) && !key.startsWith(keep)) sessionStorage.removeItem(key); } catch { /* No request is issued without its own stored key. */ }
}
