import { deny, invalid, unsupported, Fault, digest, page } from './common.mjs';

export async function workspace(db, env) {
  const row = await db.prepare('SELECT * FROM workspaces WHERE artifact_namespace=?').bind(env.ARTIFACTS_NAMESPACE).first();
  if (!row) throw new Fault('failed_precondition', 412, 'The configured native workspace has not been enrolled.');
  return row;
}
export async function organizations(db, env, person, method, body) {
  if (await db.prepare('SELECT id FROM native_owners LIMIT 1').first()) {
    const paging = page(body);
    const wire = o => ({ id: String(o.id), name: o.slug, fullName: o.full_name, description: o.description, visibility: 'ORGANIZATION_VISIBILITY_PRIVATE' });
    if (method === 'ListOrganizations') {
      const { results } = await db.prepare("SELECT o.* FROM native_owners o JOIN native_owner_members m ON m.owner_id=o.id WHERE m.user_id=? AND o.kind='ORGANIZATION' ORDER BY o.slug LIMIT ? OFFSET ?").bind(person.id,paging.limit+1,paging.offset).all();
      return { organizations: results.slice(0,paging.limit).map(wire), page: { nextPage: results.length>paging.limit ? paging.number+1 : 0 } };
    }
    const row = await db.prepare("SELECT o.* FROM native_owners o JOIN native_owner_members m ON m.owner_id=o.id WHERE m.user_id=? AND o.slug=? AND o.kind='ORGANIZATION'").bind(person.id,body.organization).first();
    if (!row) deny();
    if (method === 'GetOrganization') return { organization: wire(row) };
    unsupported();
  }
  const row = await workspace(db, env);
  const organization = { id: String(row.id), name: row.slug, fullName: row.slug, visibility: 'ORGANIZATION_VISIBILITY_PRIVATE' };
  if (method === 'ListOrganizations') return { organizations: page(body).number === 1 ? [organization] : [], page: { nextPage: 0 } };
  if (body.organization !== row.slug) deny();
  if (method === 'GetOrganization') return { organization };
  unsupported();
}
export async function stars(db, env, person, row, method, body) {
  const owner = row.owner_id ? { id: row.owner_id } : await workspace(db, env);
  if (body.repositoryId !== String(row.id)) deny();
  if (method === 'SetRepositoryStar') {
    if (body.nativeUserId !== String(person.id) || body.ownerId !== String(owner.id)) deny();
    if (typeof body.starred !== 'boolean') invalid('Select an explicit star preference.');
    await (body.starred ? db.prepare('INSERT INTO repository_stars(repository_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING') :
      db.prepare('DELETE FROM repository_stars WHERE repository_id=? AND user_id=?')).bind(row.id, person.id).run();
  }
  const value = await db.prepare('SELECT EXISTS(SELECT 1 FROM repository_stars WHERE repository_id=? AND user_id=?) AS starred,(SELECT count(*) FROM repository_stars WHERE repository_id=?) AS total').bind(row.id, person.id, row.id).first();
  return { preference: { repository: body.repository, repositoryId: String(row.id), ownerId: String(owner.id), nativeUserId: String(person.id), starred: Boolean(value.starred), starsCount: String(value.total) } };
}
export async function profile(db, person, method, body) {
  if (!['GetProfile', 'UpdateProfile'].includes(method)) unsupported();
  let saved = await db.prepare('SELECT * FROM profiles WHERE user_id=?').bind(person.id).first();
  const current = saved || { full_name: person.full_name, bio: '', location: '', website: '', version: 0 };
  const revision = await digest(JSON.stringify([person.id, person.login, current.full_name, current.bio, current.location, current.website, current.version]));
  if (method === 'UpdateProfile') {
    if (body.userId !== String(person.id)) deny();
    if (body.expectedRevision !== revision) throw new Fault('failed_precondition', 412, 'The selected profile changed. Refresh before editing.');
    const values = {};
    for (const [name, column, limit] of [['fullName', 'full_name', 100], ['bio', 'bio', 255], ['location', 'location', 50], ['website', 'website', 255]]) {
      const value = Object.hasOwn(body, name) ? body[name] : current[column];
      if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit || /\p{Cc}/u.test(name === 'bio' ? value.replace(/[\r\n\t]/g, '') : value) || new TextDecoder().decode(new TextEncoder().encode(value)) !== value) invalid('Invalid profile field.');
      values[column] = value;
    }
    if (values.website) {
      let url; try { url = new URL(values.website); } catch { invalid('Use an HTTP or HTTPS website URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) invalid('Use an HTTP or HTTPS website URL without credentials.');
    }
    const applied = await db.prepare(`INSERT INTO profiles(user_id,full_name,bio,location,website,version) VALUES(?,?,?,?,?,1)
      ON CONFLICT(user_id) DO UPDATE SET full_name=excluded.full_name,bio=excluded.bio,location=excluded.location,website=excluded.website,version=profiles.version+1 WHERE profiles.version=?`)
      .bind(person.id, values.full_name, values.bio, values.location, values.website, current.version).run();
    if (applied.meta.changes !== 1) throw new Fault('failed_precondition', 412, 'The selected profile changed.');
    saved = { ...values, version: current.version + 1 };
  }
  const result = saved || current;
  return { profile: { userId: String(person.id), login: person.login, fullName: result.full_name, bio: result.bio, location: result.location, website: result.website, canEdit: true,
    revision: await digest(JSON.stringify([person.id, person.login, result.full_name, result.bio, result.location, result.website, result.version])) } };
}
