import { digest, deny, invalid, Fault, page } from './common.mjs';

const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,38}$/.test(value);
const wire = row => ({ id: String(row.id), name: row.name, owner: row.slug, fullName: `${row.slug}/${row.name}`,
  description: row.description, topics: JSON.parse(row.topics || '[]'), updatedAt: row.created_at });
const publicRepositories = `FROM repositories r JOIN repository_visibility v ON v.repository_id=r.id AND v.is_public=1
  JOIN repository_owners ro ON ro.repository_id=r.id JOIN native_owners o ON o.id=ro.owner_id
  LEFT JOIN repository_settings s ON s.repository_id=r.id`;
const columns = 'r.id,r.name,r.created_at,o.slug,COALESCE(s.description,r.description) AS description,s.topics';

export async function discover(db, body) {
  const q = body.query ?? '', topic = body.topic ?? '', owner = body.owner ?? '';
  if (typeof q !== 'string' || q.length > 100 || /\p{Cc}/u.test(q) || typeof topic !== 'string' || topic && !/^[a-z0-9][-.a-z0-9]{0,34}$/.test(topic) || owner && !slug(owner)) invalid('Use a short search, canonical topic and owner.');
  const paging = page(body);
  const { results } = await db.prepare(`SELECT ${columns} ${publicRepositories} WHERE r.state='ACTIVE'
    AND (?='' OR o.slug=?) AND (?='' OR EXISTS(SELECT 1 FROM json_each(COALESCE(s.topics,'[]')) WHERE value=?))
    AND (?='' OR instr(lower(o.slug||'/'||r.name||' '||COALESCE(s.description,r.description)),lower(?))>0
      OR EXISTS(SELECT 1 FROM json_each(COALESCE(s.topics,'[]')) WHERE instr(lower(value),lower(?))>0))
    ORDER BY r.id DESC LIMIT ? OFFSET ?`).bind(owner,owner,topic,topic,q,q,q,paging.limit+1,paging.offset).all();
  return { repositories: results.slice(0,paging.limit).map(wire), nextPage: results.length > paging.limit ? paging.number+1 : 0 };
}

export async function publicProfile(db, person, body) {
  if (!slug(body.owner)) deny();
  const owner = await db.prepare('SELECT * FROM native_owners WHERE slug=?').bind(body.owner).first();
  if (!owner) deny();
  const authority = `EXISTS(SELECT 1 FROM native_owners o JOIN users u ON u.id=? AND u.active=1 WHERE o.id=?
    AND (o.user_id=u.id OR EXISTS(SELECT 1 FROM native_owner_members m WHERE m.owner_id=o.id AND m.user_id=u.id AND m.role='owner')))`;
  const canEdit = Boolean(await db.prepare('SELECT 1 WHERE '+authority).bind(person.id,owner.id).first());
  const saved = await db.prepare('SELECT * FROM public_profiles WHERE owner_id=?').bind(owner.id).first();
  const current = saved || { enabled: 0, display_name: owner.full_name, bio: '', location: '', website: '', readme: '', pinned: '[]', version: 0 };
  const revision = await digest(JSON.stringify([owner.id,current]));
  if (body.action === 'save') {
    if (!canEdit || body.ownerId !== String(owner.id)) deny();
    if (body.expectedRevision !== revision) throw new Fault('failed_precondition',412,'Profile changed. Refresh before editing.');
    const input = body.profile;
    if (!input || typeof input.enabled !== 'boolean' || Object.keys(input).some(k => !['enabled','displayName','bio','location','website','readme','pinned'].includes(k))) invalid('Use the public profile fields.');
    for (const [key, limit] of [['displayName',100],['bio',1000],['location',100],['website',1024],['readme',16384]]) {
      if (typeof input[key] !== 'string' || new TextEncoder().encode(input[key]).length > limit || /\p{Cc}/u.test(['bio','readme'].includes(key) ? input[key].replace(/[\n\r\t]/g,'') : input[key])) invalid('Public profile field exceeds its limit.');
    }
    if (input.website) {
      let url; try { url = new URL(input.website); } catch { invalid('Use an HTTP(S) website.'); }
      if (!['https:','http:'].includes(url.protocol) || !url.hostname || url.username || url.password) invalid('Use an HTTP(S) website without credentials.');
    }
    if (!Array.isArray(input.pinned) || input.pinned.length > 6 || new Set(input.pinned).size !== input.pinned.length || input.pinned.some(id => typeof id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(id))) invalid('Pin up to six public repositories owned by this profile.');
    for (const id of input.pinned) if (!await db.prepare(`SELECT 1 ${publicRepositories} WHERE r.id=? AND o.id=? AND r.state='ACTIVE'`).bind(id,owner.id).first()) deny();
    const changed = await db.prepare(`INSERT INTO public_profiles(owner_id,enabled,display_name,bio,location,website,readme,pinned,version)
      SELECT ?,?,?,?,?,?,?,?,1 WHERE ${authority} AND COALESCE((SELECT version FROM public_profiles WHERE owner_id=?),0)=?
      ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,display_name=excluded.display_name,bio=excluded.bio,location=excluded.location,website=excluded.website,readme=excluded.readme,pinned=excluded.pinned,version=public_profiles.version+1 WHERE public_profiles.version=?`)
      .bind(owner.id,Number(input.enabled),input.displayName,input.bio,input.location,input.website,input.readme,JSON.stringify(input.pinned),person.id,owner.id,owner.id,current.version,current.version).run();
    if (changed.meta.changes !== 1) throw new Fault('failed_precondition',412,'Profile or owner permissions changed.');
    return publicProfile(db,person,{ action:'get',owner:body.owner });
  }
  if (body.action !== 'get') invalid('Choose a public profile operation.');
  const total = await db.prepare(`SELECT count(*) AS total ${publicRepositories} WHERE r.state='ACTIVE' AND o.id=?`).bind(owner.id).first();
  if (!current.enabled && !canEdit && !total.total) deny();
  const visible = Boolean(current.enabled || canEdit), pinned = [];
  for (const id of visible ? JSON.parse(current.pinned) : []) {
    const row = await db.prepare(`SELECT ${columns} ${publicRepositories} WHERE r.id=? AND o.id=? AND r.state='ACTIVE'`).bind(id,owner.id).first();
    if (row) pinned.push(wire(row));
  }
  return { ownerId:String(owner.id),slug:owner.slug,kind:owner.kind,canEdit,revision:canEdit?revision:'',enabled:Boolean(current.enabled),
    displayName:visible?current.display_name:owner.slug,bio:visible?current.bio:'',location:visible?current.location:'',website:visible?current.website:'',
    readme:visible?current.readme:'',pinnedRepositories:pinned,publicRepositoryCount:total.total };
}
