import { digest, deny, invalid, unsupported, Fault, page, user, uuidOK } from './common.mjs';
import { repositoryAccess } from './repository-settings.mjs';

const methods = ['PreviewRepositoryInvitationRecipient', 'CreateRepositoryInvitation', 'ListRepositoryInvitations', 'ListOwnRepositoryInvitations', 'RespondRepositoryInvitation', 'RevokeRepositoryInvitation', 'GetRepositoryInvitationOperation'];
export const invitationMethods = new Set(methods);
export const ownInvitationMethods = new Set(['ListOwnRepositoryInvitations', 'RespondRepositoryInvitation', 'GetRepositoryInvitationOperation']);
const stale = () => { throw new Fault('failed_precondition', 412, 'Invitation or repository authority changed. Refresh before continuing.'); };
const rank = role => ['none', 'read', 'write', 'admin'].indexOf(role || 'none');
const contextSQL = `SELECT i.*,r.name,r.state AS repository_state,r.artifact_name AS current_artifact,w.id AS owner_id,
  u.login AS issuer_login,u.full_name AS issuer_name,u.active AS issuer_active,
  t.login AS recipient_login,t.full_name AS recipient_name,t.active AS recipient_active,
  COALESCE(uv.version,0) AS current_issuer_version,COALESCE(tv.version,0) AS current_recipient_version,
  g.role AS issuer_role,rg.role AS recipient_role,
  COALESCE(gv.generation,0) AS current_issuer_generation,COALESCE(rv.generation,0) AS current_recipient_generation
  FROM repository_invitations i JOIN repositories r ON r.id=i.repository_id
  JOIN workspaces w ON w.slug=? AND w.artifact_namespace=? JOIN users u ON u.id=i.issuer_id JOIN users t ON t.id=i.recipient_id
  LEFT JOIN native_identity_versions uv ON uv.user_id=u.id LEFT JOIN native_identity_versions tv ON tv.user_id=t.id
  LEFT JOIN grants g ON g.repository_id=r.id AND g.user_id=u.id LEFT JOIN grants rg ON rg.repository_id=r.id AND rg.user_id=t.id
  LEFT JOIN collaborator_versions gv ON gv.repository_id=r.id AND gv.user_id=u.id
  LEFT JOIN collaborator_versions rv ON rv.repository_id=r.id AND rv.user_id=t.id`;
const currentAuthority = `repository_state='ACTIVE' AND current_artifact=artifact_name AND issuer_active=1 AND recipient_active=1
  AND issuer_role='admin' AND current_issuer_version=issuer_version AND current_recipient_version=recipient_version
  AND current_issuer_generation=issuer_generation`;
function select(db, env, suffix, ...values) { return db.prepare(`SELECT * FROM (${contextSQL}) c ${suffix}`).bind(env.WORKSPACE_SLUG, env.ARTIFACTS_NAMESPACE, ...values); }
function eligible(i) { return i.repository_state === 'ACTIVE' && i.current_artifact === i.artifact_name && i.issuer_active === 1 && i.recipient_active === 1 && i.issuer_role === 'admin' && i.current_issuer_version === i.issuer_version && i.current_recipient_version === i.recipient_version && i.current_issuer_generation === i.issuer_generation; }
function wire(env, i, admin = false) {
  const detailsAvailable = admin || eligible(i) && (i.state !== 'ACCEPTED' || Boolean(i.recipient_role));
  const value = { id: i.id, revision: String(i.revision), state: i.state, expiresAt: i.expires_at, createdAt: i.created_at, detailsAvailable };
  if (detailsAvailable) Object.assign(value, { repository: { owner: env.WORKSPACE_SLUG, name: i.name }, repositoryId: String(i.repository_id), ownerId: String(i.owner_id),
    issuer: { id: String(i.issuer_id), login: i.issuer_login, fullName: i.issuer_name }, recipient: { id: String(i.recipient_id), login: i.recipient_login, fullName: i.recipient_name }, permission: i.permission, organizationOwned: true });
  return value;
}
async function recipient(db, row, login) {
  if (typeof login !== 'string' || !/^[A-Za-z0-9_.-]{1,255}$/.test(login)) invalid('Choose an enrolled account username.');
  const found = await db.prepare(`SELECT u.*,COALESCE(v.version,0) AS identity_version,COALESCE(c.generation,0) AS generation,g.role
    FROM users u LEFT JOIN native_identity_versions v ON v.user_id=u.id
    LEFT JOIN collaborator_versions c ON c.user_id=u.id AND c.repository_id=?
    LEFT JOIN grants g ON g.user_id=u.id AND g.repository_id=? WHERE u.login=? AND u.active=1`).bind(row.id, row.id, login).first();
  if (!found) deny();
  return { found, value: { user: user(found), effectivePermission: found.role || 'none', revision: await digest(JSON.stringify([row.id, row.artifact_name, found.id, found.login, found.identity_version, found.generation, found.role])) } };
}
async function expire(db, field, id, now) {
  await db.prepare(`UPDATE repository_invitations SET state='EXPIRED',revision=revision+1 WHERE ${field}=? AND state='PENDING' AND expires_at<=?`).bind(id, now).run();
}
export async function invitations(db, env, person, row, method, body, request) {
  if (!invitationMethods.has(method)) unsupported();
  // Only runtime-verified human Access identities can delegate or accept an invitation.
  if (request.headers.has('Authorization') || !person.email || request.headers.get('X-Golf-Native-Access-Email') !== person.email) throw new Fault('permission_denied', 403, 'Sign in through Cloudflare Access to manage invitations.');
  const now = new Date().toISOString();
  if (ownInvitationMethods.has(method)) {
    await expire(db, 'recipient_id', person.id, now);
    if (method === 'ListOwnRepositoryInvitations') {
      const paging = page(body), { results } = await select(db, env, 'WHERE recipient_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', person.id, paging.limit + 1, paging.offset).all();
      return { invitations: results.slice(0, paging.limit).map(i => wire(env, i)), page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } };
    }
    if (!uuidOK(body.invitationId) || !uuidOK(body.idempotencyKey)) invalid('Use the original invitation identity and a UUID v4 operation key.');
    const invitation = await select(db, env, 'WHERE id=? AND recipient_id=?', body.invitationId, person.id).first();
    if (!invitation) deny();
    const original = await db.prepare('SELECT * FROM repository_invitation_operations WHERE actor_id=? AND operation_key=?').bind(person.id, body.idempotencyKey).first();
    const decision = [1, 'REPOSITORY_INVITATION_DECISION_ACCEPT'].includes(body.decision) ? 'ACCEPTED' : [2, 'REPOSITORY_INVITATION_DECISION_REJECT'].includes(body.decision) ? 'REJECTED' : '';
    const hash = await digest(JSON.stringify([invitation.id, body.expectedRevision, decision]));
    if (original) {
      if (original.invitation_id !== invitation.id) deny();
      if (method === 'RespondRepositoryInvitation' && original.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation key belongs to another invitation decision.');
      return { operation: JSON.parse(original.receipt), ...(method === 'RespondRepositoryInvitation' ? { invitation: wire(env, invitation) } : {}) };
    }
    if (method === 'GetRepositoryInvitationOperation') deny();
    if (!decision || !/^[1-9][0-9]{0,15}$/.test(body.expectedRevision || '')) invalid('Choose an invitation decision and its current revision.');
    const accepted = decision === 'ACCEPTED';
    const allowed = invitation.state === 'PENDING' && String(invitation.revision) === body.expectedRevision && eligible(invitation) &&
      (!accepted || invitation.current_recipient_generation === invitation.recipient_generation && rank(invitation.recipient_role) < rank(invitation.permission));
    const operation = { idempotencyKey: body.idempotencyKey, invitationId: invitation.id, invitationRevision: body.expectedRevision, repositoryId: String(invitation.repository_id), ownerId: String(invitation.owner_id), recipientId: String(person.id), phase: allowed ? 'SUCCEEDED' : 'REJECTED', failureCode: allowed ? '' : 'preflight_refused', createdAt: now, updatedAt: now };
    const record = db.prepare(`INSERT INTO repository_invitation_operations(actor_id,operation_key,invitation_id,input_hash,receipt) VALUES(?,?,?,?,?)`).bind(person.id, body.idempotencyKey, invitation.id, hash, JSON.stringify(operation));
    if (!allowed) {
      await record.run();
      return { operation, invitation: wire(env, invitation) };
    }
    const qualified = `${currentAuthority} AND c.id=? AND recipient_id=? AND state='PENDING' AND revision=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')${accepted ? ' AND current_recipient_generation=recipient_generation' : ''}`;
    const guardedRecord = db.prepare(`INSERT INTO repository_invitation_operations(actor_id,operation_key,invitation_id,input_hash,receipt)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM (${contextSQL}) c WHERE ${qualified})`)
      .bind(person.id, body.idempotencyKey, invitation.id, hash, JSON.stringify(operation), env.WORKSPACE_SLUG, env.ARTIFACTS_NAMESPACE, invitation.id, person.id, Number(body.expectedRevision));
    const guard = 'EXISTS(SELECT 1 FROM repository_invitation_operations WHERE actor_id=? AND operation_key=?)';
    const statements = [guardedRecord];
    if (accepted) statements.push(db.prepare(`INSERT INTO grants(repository_id,user_id,role) SELECT ?,?,? WHERE ${guard} ON CONFLICT(repository_id,user_id) DO UPDATE SET role=excluded.role`).bind(invitation.repository_id, person.id, invitation.permission, person.id, body.idempotencyKey));
    statements.push(db.prepare(`UPDATE repository_invitations SET state=?,revision=revision+1 WHERE id=? AND ${guard}`).bind(decision, invitation.id, person.id, body.idempotencyKey));
    const results = await db.batch(statements);
    if (results[0].meta.changes !== 1) {
      operation.phase = 'REJECTED'; operation.failureCode = 'preflight_refused';
      await db.prepare('INSERT INTO repository_invitation_operations VALUES(?,?,?,?,?)').bind(person.id, body.idempotencyKey, invitation.id, hash, JSON.stringify(operation)).run();
    }
    const observed = await select(db, env, 'WHERE id=?', invitation.id).first();
    return { operation, invitation: wire(env, observed) };
  }
  if (!row || body.repositoryId !== String(row.id) || body.ownerId !== String(row.workspace_id)) deny();
  let hash;
  if (method === 'CreateRepositoryInvitation') {
    if (row.role !== 'admin' || !uuidOK(body.idempotencyKey)) deny();
    hash = await digest(JSON.stringify([row.id, row.workspace_id, body.recipientId, body.recipientUsername, body.recipientRevision, body.permission, body.expiresAt, body.expectedRevision, body.persistentConsent]));
    const previous = await select(db, env, 'WHERE issuer_id=? AND operation_key=?', person.id, body.idempotencyKey).first();
    if (previous) {
      if (previous.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation key belongs to another invitation.');
      return { invitation: wire(env, previous, true) };
    }
  }
  const { access } = await repositoryAccess(db, env, person, row);
  if (access.revision !== body.expectedRevision) stale();
  if (method === 'ListRepositoryInvitations' && row.role !== 'admin') return { repositoryId: String(row.id), ownerId: String(row.workspace_id), accessRevision: access.revision, invitations: [], page: { nextPage: 0 }, canManage: false, localIssuerAvailable: false };
  if (row.role !== 'admin') deny();
  await expire(db, 'repository_id', row.id, now);
  if (method === 'ListRepositoryInvitations') {
    const paging = page(body), { results } = await select(db, env, 'WHERE repository_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', row.id, paging.limit + 1, paging.offset).all();
    return { invitations: results.slice(0, paging.limit).map(i => wire(env, i, true)), page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 }, repositoryId: String(row.id), ownerId: String(row.workspace_id), accessRevision: access.revision, canManage: true, localIssuerAvailable: true };
  }
  if (method === 'RevokeRepositoryInvitation') {
    if (!uuidOK(body.invitationId) || !/^[1-9][0-9]{0,15}$/.test(body.invitationRevision || '')) invalid('Use the current invitation identity and revision.');
    const result = await db.prepare(`UPDATE repository_invitations SET state='REVOKED',revision=revision+1
      WHERE id=? AND repository_id=? AND revision=? AND state='PENDING'
      AND EXISTS(SELECT 1 FROM grants g JOIN users u ON u.id=g.user_id WHERE g.repository_id=? AND g.user_id=? AND g.role='admin' AND u.active=1)
      AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=?),0)=?`)
      .bind(body.invitationId, row.id, Number(body.invitationRevision), row.id, person.id, row.id, row.access_version).run();
    if (result.meta.changes !== 1) stale();
    return { invitation: wire(env, await select(db, env, 'WHERE id=?', body.invitationId).first(), true) };
  }
  const { found, value } = await recipient(db, row, method === 'PreviewRepositoryInvitationRecipient' ? body.username : body.recipientUsername);
  if (method === 'PreviewRepositoryInvitationRecipient') return { recipient: value, repositoryId: String(row.id), ownerId: String(row.workspace_id), accessRevision: access.revision };
  if (!uuidOK(body.idempotencyKey) || body.persistentConsent !== true || !['read', 'write', 'admin'].includes(body.permission)) invalid('Confirm delegated authority, a permission and a UUID v4 operation key.');
  if (body.recipientId !== String(found.id)) deny();
  if (body.recipientRevision !== value.revision || found.id === person.id || rank(found.role) >= rank(body.permission)) stale();
  const expiry = Date.parse(body.expiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== body.expiresAt || expiry <= Date.now() || expiry > Date.now() + 7 * 86400000) invalid('Choose an expiry within seven days.');
  const issuer = (await recipient(db, row, person.login)).found;
  if (issuer.email !== person.email || issuer.identity_version !== person.identity_version) deny();
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO repository_invitations(id,repository_id,artifact_name,issuer_id,issuer_version,issuer_generation,recipient_id,recipient_version,recipient_generation,permission,expires_at,created_at,operation_key,input_hash)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM grants g JOIN users u ON u.id=g.user_id JOIN repositories r ON r.id=g.repository_id WHERE g.repository_id=? AND g.user_id=? AND g.role='admin' AND u.active=1 AND r.state='ACTIVE' AND r.artifact_name=?)
    AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=?),0)=?
    AND COALESCE((SELECT version FROM native_identity_versions WHERE user_id=?),0)=?
    AND EXISTS(SELECT 1 FROM users u LEFT JOIN native_identity_versions v ON v.user_id=u.id WHERE u.id=? AND u.active=1 AND COALESCE(v.version,0)=?)
    AND NOT EXISTS(SELECT 1 FROM repository_invitations WHERE repository_id=? AND recipient_id=? AND state='PENDING')`)
    .bind(id, row.id, row.artifact_name, person.id, issuer.identity_version, issuer.generation, found.id, found.identity_version, found.generation, body.permission, body.expiresAt, now, body.idempotencyKey, hash,
      row.id, person.id, row.artifact_name, row.id, row.access_version, person.id, issuer.identity_version, found.id, found.identity_version, row.id, found.id).run();
  if (result.meta.changes !== 1) throw new Fault('failed_precondition', 412, 'A pending invitation already exists or the reviewed authority changed. Refresh invitations.');
  return { invitation: wire(env, await select(db, env, 'WHERE id=?', id).first(), true) };
}
