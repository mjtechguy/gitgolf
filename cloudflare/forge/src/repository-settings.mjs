import { advertisedRefs, gitRequest, validRef } from './git.mjs';
import { digest, deny, invalid, unsupported, Fault, page, user, uuidOK } from './common.mjs';

export async function repositorySettings(db, env, person, row, method, body, artifact) {
  if (!Number.isSafeInteger(row.workspace_id) || row.workspace_id < 1) deny();
  const owner = { id: row.workspace_id };
  const saved = await db.prepare('SELECT * FROM repository_settings WHERE repository_id=?').bind(row.id).first();
  const current = saved || { description: row.description, website: '', topics: '[]', version: 0 };
  const revision = await digest(JSON.stringify([row.id, owner.id, row.artifact_name, row.default_branch, current.description, current.website, current.topics, current.version]));
  if (method !== 'GetRepositorySettings') {
    if (!['UpdateRepositorySettings', 'UpdateRepositoryTopics'].includes(method)) unsupported();
    if (row.role !== 'admin' || body.repositoryId !== String(row.id) || body.ownerId !== String(owner.id)) deny();
    if (body.expectedRevision !== revision) throw new Fault('failed_precondition', 412, 'Repository settings changed. Refresh before editing.');
    // Proto JSON omits an empty repeated field; omission clears the topic list.
    if (method === 'UpdateRepositoryTopics' && !Object.hasOwn(body, 'topics')) body = { ...body, topics: [] };
    const allowed = ['repository', 'repositoryId', 'ownerId', 'expectedRevision', ...(method === 'UpdateRepositoryTopics' ? ['topics'] : ['description', 'website', 'defaultBranch'])];
    if (Object.keys(body).some(key => !allowed.includes(key))) invalid('This installation edits description, website, topics and an existing default branch; repository feature policy is operator-managed.');
    if (!Object.keys(body).some(key => ['description', 'website', 'topics', 'defaultBranch'].includes(key))) invalid('Change a repository setting.');
    const changed = { ...current };
    for (const field of ['description', 'website']) if (Object.hasOwn(body, field)) {
      const value = body[field];
      if (typeof value !== 'string' || new TextEncoder().encode(value).length > (field === 'description' ? 2048 : 1024) || /\p{Cc}/u.test(field === 'description' ? value.replace(/[\r\n\t]/g, '') : value) || new TextDecoder().decode(new TextEncoder().encode(value)) !== value) invalid('Invalid repository setting.');
      changed[field] = value;
    }
    if (changed.website) {
      let url; try { url = new URL(changed.website); } catch { invalid('Use an HTTP or HTTPS website URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) invalid('Use an HTTP or HTTPS website URL without credentials.');
    }
    if (method === 'UpdateRepositoryTopics') {
      if (!Array.isArray(body.topics) || body.topics.length > 25 || new Set(body.topics).size !== body.topics.length || body.topics.some(topic => typeof topic !== 'string' || topic.length > 35 || !/^[a-z0-9][-.a-z0-9]*$/.test(topic))) invalid('Use at most 25 unique lowercase topics.');
      changed.topics = JSON.stringify([...body.topics].sort());
    }
    const defaultBranch = Object.hasOwn(body,'defaultBranch') ? body.defaultBranch : row.default_branch;
    if (Object.hasOwn(body,'defaultBranch')) {
      if (!validRef('refs/heads/'+defaultBranch) || typeof defaultBranch!=='string') invalid('Choose an existing named branch.');
      if (row.write_pending) throw new Fault('failed_precondition',412,'Resolve the pending Git write before changing the default branch.');
      const refs=await artifact(async repo=>advertisedRefs((await gitRequest(env,repo,row.artifact_name,'info/refs?service=git-upload-pack','git-upload-pack',null)).bytes));
      if (!refs.has('refs/heads/'+defaultBranch)) throw new Fault('failed_precondition',412,'The selected default branch does not exist.');
    }
    const authority=settingsAuthority(person,row);
    const statements=[db.prepare(`INSERT INTO repository_settings(repository_id,description,website,topics,version)
      SELECT ?,?,?,?,1 WHERE ${authority.sql} AND EXISTS(SELECT 1 FROM repositories WHERE id=? AND default_branch=? ${Object.hasOwn(body,'defaultBranch')?'AND write_pending IS NULL':''})
      AND COALESCE((SELECT version FROM repository_settings WHERE repository_id=?),0)=?
      ON CONFLICT(repository_id) DO UPDATE SET description=excluded.description,website=excluded.website,topics=excluded.topics,version=repository_settings.version+1 WHERE repository_settings.version=?`)
      .bind(row.id,changed.description,changed.website,changed.topics,...authority.values,row.id,row.default_branch,row.id,current.version,current.version)];
    if (Object.hasOwn(body,'defaultBranch')) statements.push(db.prepare('UPDATE repositories SET default_branch=? WHERE id=? AND changes()=1').bind(defaultBranch,row.id));
    const results=await db.batch(statements);
    if (results[0].meta.changes !== 1) throw new Fault('failed_precondition', 412, 'Repository settings or authority changed.');
    return repositorySettings(db, env, person, {...row,default_branch:defaultBranch}, 'GetRepositorySettings', body, artifact);
  }
  const authority=settingsAuthority(person,row);
  if (!await db.prepare(`SELECT 1 WHERE ${authority.sql}`).bind(...authority.values).first()) deny();
  return { settings: { repositoryId: String(row.id), ownerId: String(owner.id), description: current.description, website: current.website,
    topics: JSON.parse(current.topics), defaultBranch: row.default_branch, hasIssues: true, hasWiki: false, hasPullRequests: true,
    issuesMode: 'REPOSITORY_FEATURE_MODE_INTERNAL', wikiMode: 'REPOSITORY_FEATURE_MODE_DISABLED', canEdit: row.role === 'admin', generalEditImplemented: true, revision } };
}

function settingsAuthority(person,row) {
  return {sql:`EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
    WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND g.role=? AND u.active=1)
    AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=?),0)=?
    AND COALESCE((SELECT version FROM native_identity_versions WHERE user_id=?),0)=?
    ${person.credential_digest?'AND EXISTS(SELECT 1 FROM credentials WHERE digest=? AND user_id=? AND revoked=0 AND expires_at>unixepoch())':''}`,
    values:[row.id,row.artifact_name,person.id,row.role,row.id,row.access_version,person.id,person.identity_version,...(person.credential_digest?[person.credential_digest,person.id]:[])]};
}

export async function repositoryAccess(db, env, person, row, version) {
  if (!Number.isSafeInteger(row.workspace_id) || row.workspace_id < 1) deny();
  const owner = { id: row.workspace_id, slug: env.WORKSPACE_SLUG };
  if (version === undefined) version = row.access_version ?? ((await db.prepare('SELECT version FROM repository_access_versions WHERE repository_id=?').bind(row.id).first())?.version || 0);
  return { access: { repositoryId: String(row.id), ownerId: String(owner.id), owner: { id: String(owner.id), login: owner.slug }, organizationOwned: true,
    canManage: row.role === 'admin', currentPermission: row.role, revision: await digest(JSON.stringify([row.id, row.artifact_name, owner.id, person.id, row.role, version])) } };
}

const accessStale = () => { throw new Fault('failed_precondition', 412, 'Repository access changed. Refresh and review the change again.'); };
async function wireCollaborator(row, grant) {
  return { user: user(grant), permission: grant.role || 'none', isDirect: Boolean(grant.role), generation: String(grant.generation), actualOrganizationOwner: false,
    revision: await digest(JSON.stringify([row.id, row.artifact_name, grant.id, grant.login, grant.active, grant.role, grant.generation])) };
}
async function collaborator(db, row, recipient) {
  const grant = await db.prepare(`SELECT u.*,g.role,COALESCE(v.generation,0) AS generation FROM users u
    LEFT JOIN grants g ON g.user_id=u.id AND g.repository_id=?
    LEFT JOIN collaborator_versions v ON v.user_id=u.id AND v.repository_id=? WHERE u.id=?`).bind(row.id, row.id, recipient).first();
  if (!grant) deny();
  return wireCollaborator(row, grant);
}

export async function repositoryCollaborators(db, env, person, row, method, body) {
  if (method === 'GetRepositoryAccess') return repositoryAccess(db, env, person, row);
  if (!['ListRepositoryCollaborators', 'ResolveRepositoryCollaborator', 'SetRepositoryCollaborator', 'RemoveRepositoryCollaborator', 'GetRepositoryAccessOperation'].includes(method)) unsupported();
  if (row.role !== 'admin' || body.repositoryId !== String(row.id) || body.ownerId !== String(row.workspace_id)) deny();
  const mutation = ['SetRepositoryCollaborator', 'RemoveRepositoryCollaborator'].includes(method);
  const remove = method === 'RemoveRepositoryCollaborator';
  let hash;
  if (mutation || method === 'GetRepositoryAccessOperation') {
    if (!uuidOK(body.idempotencyKey)) invalid('Use a UUID v4 operation key.');
    if (mutation) {
      if (!remove && !['read', 'write', 'admin'].includes(body.permission) || remove && Object.hasOwn(body, 'permission')) invalid('Choose read, write or admin access.');
      hash = await digest(JSON.stringify([method, row.id, row.workspace_id, body.userId, body.userLogin, body.permission || '', body.expectedRevision, body.expectedCollaboratorRevision]));
    }
    const previous = await db.prepare('SELECT * FROM repository_access_operations WHERE actor_id=? AND operation_key=?').bind(person.id, body.idempotencyKey).first();
    if (previous) {
      if (previous.repository_id !== row.id || String(previous.recipient_id) !== body.userId) deny();
      if (mutation && previous.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation key belongs to another access change.');
      // Historical receipts never borrow a later collaborator observation.
      return { operation: JSON.parse(previous.receipt) };
    }
    if (method === 'GetRepositoryAccessOperation') deny();
  }
  const version = row.access_version ?? ((await db.prepare('SELECT version FROM repository_access_versions WHERE repository_id=?').bind(row.id).first())?.version || 0);
  const { access } = await repositoryAccess(db, env, person, row, version);
  if (body.expectedRevision !== access.revision) accessStale();
  if (method === 'ListRepositoryCollaborators') {
    const paging = page(body);
    const { results } = await db.prepare(`SELECT u.*,g.role,COALESCE(v.generation,0) AS generation FROM grants g JOIN users u ON u.id=g.user_id
      LEFT JOIN collaborator_versions v ON v.repository_id=g.repository_id AND v.user_id=g.user_id
      WHERE g.repository_id=? ORDER BY u.id LIMIT ? OFFSET ?`).bind(row.id, paging.limit + 1, paging.offset).all();
    return { collaborators: await Promise.all(results.slice(0, paging.limit).map(value => wireCollaborator(row, value))), page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } };
  }
  if (typeof body.userLogin !== 'string' || !body.userLogin || body.userLogin.length > 255 || /\p{Cc}/u.test(body.userLogin)) invalid('Choose an enrolled account username.');
  const recipient = await db.prepare('SELECT * FROM users WHERE login=?').bind(body.userLogin).first();
  if (!recipient) deny();
  const current = await collaborator(db, row, recipient.id);
  if (method === 'ResolveRepositoryCollaborator') return { collaborator: current };
  if (body.userId !== String(recipient.id)) deny();
  if (recipient.id === person.id) throw new Fault('failed_precondition', 412, 'Your own repository grant cannot be changed here.');
  if (!remove && recipient.active !== 1) throw new Fault('failed_precondition', 412, 'Choose an active enrolled account.');
  if (body.expectedCollaboratorRevision !== current.revision || remove && !current.isDirect) accessStale();
  const generation = Number(current.generation) + 1, time = new Date().toISOString();
  if (!Number.isSafeInteger(generation)) throw Error('Access generation limit reached');
  const operation = { idempotencyKey: body.idempotencyKey, repository: { owner: env.WORKSPACE_SLUG, name: row.name }, repositoryId: String(row.id), ownerId: String(row.workspace_id),
    recipientId: String(recipient.id), recipientLogin: recipient.login, actorId: String(person.id), requestedPermission: remove ? '' : body.permission, remove,
    generation: String(generation), phase: 'SUCCEEDED', failureCode: '', createdAt: time, updatedAt: time, observedEffectivePermission: remove ? 'none' : body.permission, observedDirectMembership: !remove };
  // The receipt and grant commit in one D1 transaction. Admission is rechecked inside
  // that transaction; an original key is never used to repeat the grant mutation.
  const insert = db.prepare(`INSERT INTO repository_access_operations(actor_id,operation_key,repository_id,recipient_id,input_hash,receipt)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
      WHERE r.id=? AND r.name=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND g.role='admin' AND u.active=1)
    AND COALESCE((SELECT version FROM repository_access_versions WHERE repository_id=?),0)=?
    AND EXISTS(SELECT 1 FROM users WHERE id=? AND login=? AND active=?)`)
    .bind(person.id, body.idempotencyKey, row.id, recipient.id, hash, JSON.stringify(operation), row.id, row.name, row.artifact_name, person.id, row.id, version, recipient.id, recipient.login, recipient.active);
  const change = remove
    ? db.prepare('DELETE FROM grants WHERE repository_id=? AND user_id=? AND EXISTS(SELECT 1 FROM repository_access_operations WHERE actor_id=? AND operation_key=?)').bind(row.id, recipient.id, person.id, body.idempotencyKey)
    : db.prepare(`INSERT INTO grants(repository_id,user_id,role) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM repository_access_operations WHERE actor_id=? AND operation_key=?)
        ON CONFLICT(repository_id,user_id) DO UPDATE SET role=excluded.role`).bind(row.id, recipient.id, body.permission, person.id, body.idempotencyKey);
  const results = await db.batch([insert, change]);
  if (results[0].meta.changes !== 1) accessStale();
  // D1 includes the revision triggers in changes; the grant key remains unique.
  if (results[1].meta.changes < 1) throw Error('Access change receipt requires inspection');
  return { operation };
}

export async function repositoryPackages(env, person, row, body) {
  if (!env.REGISTRY || !env.REGISTRY_ORIGIN) unsupported();
  const operations = ['trust', 'updateTrust', 'verification', 'verify', 'scan', 'jobs', 'cancelScan', 'settings', 'updateSettings', 'policy', 'hold', 'promote', 'retention', 'retentionApply', 'inventory', 'artifact', 'attachments', 'activity', 'report', 'downloadReport', 'compareSbom', 'link'];
  if (body.repositoryId !== String(row.id) || !['status', 'enable', 'credential', 'revoke', ...operations].includes(body.action)) invalid('Use the current repository and a supported package action.');
  if (body.action === 'enable' && row.role !== 'admin') deny();
  const binding = { contract: 1, installation: env.PUBLIC_ORIGIN, name: `${env.WORKSPACE_SLUG}/${row.name}`, repositoryId: String(row.id), artifactName: row.artifact_name };
  const input = Object.fromEntries(['reference', 'kind', 'query', 'cursor', 'limit', 'expectedRevision', 'links', 'attachment', 'blob', 'settings', 'reason', 'enabled', 'tag', 'digests', 'jobId', 'idempotencyKey', 'keys', 'baseline'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  const result = await env.REGISTRY.manage({ ...input, action: body.action, binding, actorId: String(person.id), canPush: ['write', 'admin'].includes(row.role) });
  if (result.registryError) {
    const error = result.registryError;
    if (![400, 401, 403, 404, 409, 413, 422, 429, 503].includes(error.status) || typeof error.message !== 'string' || error.message.length > 4096) throw Error('Invalid registry refusal');
    throw new Fault(error.status === 403 ? 'permission_denied' : error.status === 409 ? 'failed_precondition' : error.status === 404 ? 'not_found' : error.status === 429 ? 'resource_exhausted' : error.status >= 500 ? 'unavailable' : 'invalid_argument', error.status, error.message);
  }
  if (result.registry && result.registry !== env.REGISTRY_ORIGIN || result.name && result.name !== binding.name) throw Error('Registry binding receipt differs from the configured destination');
  return { ...result, repositoryId: String(row.id), canManage: row.role === 'admin', canPush: ['write', 'admin'].includes(row.role) };
}

export async function registryAuthority(env, input) {
  const { binding, actorId } = input || {};
  const refused = { read: false, write: false };
  if (!env.REGISTRY || !binding || binding.contract !== 1 || binding.installation !== env.PUBLIC_ORIGIN ||
      !/^[1-9][0-9]*$/.test(actorId || '') || !/^[1-9][0-9]*$/.test(binding.repositoryId || '') ||
      env.DEMO_STOP_AT && Date.parse(env.DEMO_STOP_AT) <= Date.now()) return refused;
  const row = await env.DB.withSession('first-primary').prepare(`SELECT r.*,g.role FROM repositories r
    JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
    WHERE r.id=? AND u.id=? AND u.active=1 AND r.state='ACTIVE'`).bind(binding.repositoryId, actorId).first();
  if (!row || row.artifact_name !== binding.artifactName || binding.name !== `${env.WORKSPACE_SLUG}/${row.name}`) return refused;
  if (input.execution) {
    if (!['write','admin'].includes(row.role) || env.REGISTRY_CI_ENABLED !== 'true' || !env.registryExecution || !await env.registryExecution(actorId,row,input.execution)) return refused;
    return { read:true, write:true, admin:false, execution:true };
  }
  return { read: true, write: ['write', 'admin'].includes(row.role), admin: row.role === 'admin' };
}
