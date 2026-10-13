import { deny, invalid, Fault, digest, uuidOK } from './common.mjs';

export const ownerSlug = (row, env) => row.owner_slug || env.WORKSPACE_SLUG;
export const ownerJoin = 'LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id';
export const ownerColumns = 'o.slug AS owner_slug,o.kind AS owner_kind,o.id AS owner_id';
const slugOK = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,38}$/.test(value);
export async function withOwner(db, row) {
  if (!row) return row;
  const owner = await db.prepare('SELECT o.slug AS owner_slug,o.kind AS owner_kind,o.id AS owner_id FROM repository_owners ro JOIN native_owners o ON o.id=ro.owner_id WHERE ro.repository_id=?').bind(row.id).first();
  return owner ? { ...row, ...owner, workspace_id: owner.owner_id } : row;
}
export async function creationOwner(db, person, slug) {
  const row = slug ? await db.prepare('SELECT * FROM native_owners WHERE slug=?').bind(slug).first()
    : await db.prepare("SELECT * FROM native_owners WHERE kind='PERSONAL' AND user_id=?").bind(person.id).first();
  if (!row) { if (slug) deny(); return null; }
  if (row.kind === 'PERSONAL' ? row.user_id !== person.id : !(await db.prepare("SELECT 1 AS ok FROM native_owner_members WHERE owner_id=? AND user_id=? AND role='owner'").bind(row.id,person.id).first())) deny();
  return row;
}
export async function ownersAPI(db, person, body) {
  if (body.action === 'listMembers') {
    const owner = await db.prepare("SELECT o.id FROM native_owners o JOIN native_owner_members m ON m.owner_id=o.id WHERE o.slug=? AND o.kind='ORGANIZATION' AND m.user_id=?").bind(body.organization,person.id).first();
    if (!owner) deny();
    const { results } = await db.prepare('SELECT u.id,u.login,COALESCE(p.full_name,u.full_name) AS fullName,m.role FROM native_owner_members m JOIN users u ON u.id=m.user_id LEFT JOIN profiles p ON p.user_id=u.id WHERE m.owner_id=? AND u.active=1 ORDER BY u.login LIMIT 101').bind(owner.id).all();
    return { members: results.slice(0,100), truncated: results.length>100 };
  }
  if (!person.can_create) deny();
  if (body.action === 'ensurePersonal') {
    if (body.userId !== String(person.id) || !slugOK(body.login) || typeof body.expectedLogin !== 'string') invalid('Select your current account and canonical login.');
    const current = await db.prepare("SELECT * FROM native_owners WHERE kind='PERSONAL' AND user_id=?").bind(person.id).first();
    if (current && current.slug !== body.login) throw new Fault('failed_precondition',412,'Renaming an established repository owner requires a separate migration.');
    if (person.login !== body.expectedLogin && person.login !== body.login) throw new Fault('failed_precondition',412,'The selected account login changed.');
    const occupied = await db.prepare('SELECT id FROM users WHERE login=? AND id!=?').bind(body.login,person.id).first();
    const owner = await db.prepare('SELECT * FROM native_owners WHERE slug=?').bind(body.login).first();
    if (occupied || owner && owner.user_id !== person.id) throw new Fault('already_exists',409,'The selected owner name is unavailable.');
    if (await db.prepare("SELECT 1 AS pending FROM evidence_jobs WHERE user_id=? AND state NOT IN ('SUCCEEDED','REFUSED','EXPIRED') LIMIT 1").bind(person.id).first()) throw new Fault('failed_precondition',412,'Wait for active CI before changing account ownership.');
    await db.batch([
      db.prepare("INSERT INTO native_owners(slug,kind,user_id,full_name,creator_id) VALUES(?,'PERSONAL',?,?,?) ON CONFLICT(slug) DO NOTHING").bind(body.login,person.id,person.full_name,person.id),
      db.prepare('UPDATE users SET login=? WHERE id=? AND login=?').bind(body.login,person.id,person.login),
      db.prepare('INSERT INTO repository_owners(repository_id,owner_id) SELECT r.id,o.id FROM repositories r JOIN native_owners o ON o.user_id=r.creator_id WHERE r.creator_id=? AND NOT EXISTS(SELECT 1 FROM repository_owners ro WHERE ro.repository_id=r.id)').bind(person.id),
    ]);
    return { owner: await db.prepare('SELECT * FROM native_owners WHERE user_id=?').bind(person.id).first() };
  }
  if (body.action !== 'createOrganization') invalid('Choose a supported owner operation.');
  if (!slugOK(body.slug) || !uuidOK(body.idempotencyKey) || typeof body.fullName !== 'string' || body.fullName.length > 100 || typeof body.description !== 'string' || body.description.length > 1000 || /\p{Cc}/u.test(body.fullName+body.description)) invalid('Use a canonical organization name, bounded description and UUID operation key.');
  const hash = await digest(JSON.stringify([body.slug,body.fullName,body.description]));
  const prior = await db.prepare('SELECT * FROM native_owners WHERE creator_id=? AND creation_key=?').bind(person.id,body.idempotencyKey).first();
  if (prior) {
    if (prior.input_hash !== hash) throw new Fault('already_exists',409,'Operation key belongs to different inputs.');
    await creationOwner(db,person,prior.slug);
    return { owner: prior };
  }
  if (await db.prepare('SELECT id FROM native_owners WHERE slug=? UNION ALL SELECT id FROM users WHERE login=?').bind(body.slug,body.slug).first()) throw new Fault('already_exists',409,'The selected owner name is unavailable.');
  await db.batch([
    db.prepare("INSERT INTO native_owners(slug,kind,full_name,description,creator_id,creation_key,input_hash) VALUES(?,'ORGANIZATION',?,?,?,?,?)").bind(body.slug,body.fullName,body.description,person.id,body.idempotencyKey,hash),
    db.prepare("INSERT INTO native_owner_members(owner_id,user_id,role) SELECT id,?,'owner' FROM native_owners WHERE creator_id=? AND creation_key=?").bind(person.id,person.id,body.idempotencyKey),
  ]);
  return { owner: await db.prepare('SELECT * FROM native_owners WHERE creator_id=? AND creation_key=?').bind(person.id,body.idempotencyKey).first() };
}
