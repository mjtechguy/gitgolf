import { ownerSlug } from './owners.mjs';
import { digest, deny, invalid, Fault, page } from './common.mjs';

export const gitCredentialMethods = new Set(['GetGitTransport','CreateGitCredential','ListGitCredentials','RevokeGitCredential']);
const nowSQL = "CAST(strftime('%s','now') AS INTEGER)";
const unauthenticated = () => { throw new Fault('unauthenticated',401,'Valid repository Git credentials required.'); };
const iso = value => new Date(value*1000).toISOString();

// Shared by admission and the atomic write reservation; credentials never authorize RPCs.
export const gitCredentialSQL = `SELECT c.*,u.login,u.email,u.active,u.can_create,COALESCE(p.full_name,u.full_name) AS full_name
 FROM git_credentials c JOIN users u ON u.id=c.user_id JOIN repositories r ON r.id=c.repository_id
 JOIN grants g ON g.repository_id=r.id AND g.user_id=u.id
 LEFT JOIN collaborator_versions a ON a.repository_id=r.id AND a.user_id=u.id
 LEFT JOIN native_identity_versions v ON v.user_id=u.id LEFT JOIN profiles p ON p.user_id=u.id
 WHERE c.digest=? AND c.revoked_at IS NULL AND c.expires_at>${nowSQL} AND u.active=1 AND r.state='ACTIVE'
 AND r.artifact_name=c.artifact_name AND c.identity_version=COALESCE(v.version,0)
 AND c.grant_generation=COALESCE(a.generation,0) AND (c.mode=1 OR g.role IN ('write','admin'))`;

export async function gitCredentialActor(db, request) {
 const authorization=request.headers.get('Authorization')||'';
 let token;
 if (/^Bearer golf_git_[A-Za-z0-9_-]{43}$/.test(authorization)) token=authorization.slice(7);
 else if (authorization.startsWith('Basic ') && authorization.length<=256) {
  try {const decoded=atob(authorization.slice(6));if (/^golf:golf_git_[A-Za-z0-9_-]{43}$/.test(decoded) && btoa(decoded)===authorization.slice(6)) token=decoded.slice(5);} catch { /* Invalid Basic encoding is never a browser identity. */ }
 }
 const url=new URL(request.url),route=/^\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
 if (!token || !route) unauthenticated();
 const hash=await digest(token),c=await db.prepare(gitCredentialSQL+' AND r.name=?').bind(hash,route[2]).first();
 if (!c) unauthenticated();
 if (c.mode!==2 && (route[3]==='git-receive-pack' || url.searchParams.get('service')==='git-receive-pack')) deny();
 return {id:c.user_id,login:c.login,email:c.email,active:c.active,can_create:c.can_create,full_name:c.full_name,
  identity_version:c.identity_version,git_credential_digest:hash,git_repository_id:c.repository_id};
}
export async function confirmGitCredential(db, person, row) {
 if (!person.git_credential_digest) return;
 const current=await db.prepare(gitCredentialSQL+' AND c.repository_id=?').bind(person.git_credential_digest,row.id).first();
 if (!current || current.user_id!==person.id) unauthenticated();
}
function wire(c,row,person,generation) {
 return {id:String(c.id),label:c.label,repositoryId:String(row.id),ownerId:String(row.workspace_id),mode:c.mode,
  createdAt:iso(c.created_at),expiresAt:iso(c.expires_at),revokedAt:c.revoked_at===null?'':iso(c.revoked_at),
  identityBound:true,sourceIdentityActive:c.artifact_name===row.artifact_name && c.identity_version===(person.identity_version||0) && c.grant_generation===generation && (c.mode===1 || ['write','admin'].includes(row.role))};
}
export async function gitCredentials(db,env,person,row,request,method,body) {
 if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') || request.headers.get('Origin')!==env.PUBLIC_ORIGIN || body.repositoryId!==String(row.id) || body.ownerId!==String(row.workspace_id)) deny();
 const generation=(await db.prepare('SELECT generation FROM collaborator_versions WHERE repository_id=? AND user_id=?').bind(row.id,person.id).first())?.generation||0;
 const guard=`EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
  LEFT JOIN collaborator_versions a ON a.repository_id=r.id AND a.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
  WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND u.id=? AND g.role=? AND u.active=1 AND COALESCE(a.generation,0)=? AND COALESCE(v.version,0)=?)`;
 const values=[row.id,row.artifact_name,person.id,row.role,generation,person.identity_version||0];
 const current=async()=>{if(!await db.prepare(`SELECT 1 WHERE ${guard}`).bind(...values).first())deny();};
 if (method==='GetGitTransport') {
  await current();return {repository:body.repository,repositoryId:String(row.id),ownerId:String(row.workspace_id),enabled:true,cloneUrl:env.PUBLIC_ORIGIN+'/git/'+ownerSlug(row,env)+'/'+row.name+'.git',readCredentialAvailable:true,
   writeCredentialAvailable:['write','admin'].includes(row.role),writeNotice:'Repository-only HTTPS credentials expire within one hour. Current Golf account and repository access are required; changing either revokes existing credentials. Access remains the outer gate: Git clients also need an approved Access session or machine credential. Pushes obey branch locks and tag restrictions; single-ref SHA-1 pushes are limited to 8 MiB.'};
 }
 if (method==='ListGitCredentials') {
  const paging=page(body),{results}=await db.prepare('SELECT * FROM git_credentials WHERE user_id=? AND repository_id=? ORDER BY id DESC LIMIT ? OFFSET ?').bind(person.id,row.id,paging.limit+1,paging.offset).all();
  await current();return {credentials:results.slice(0,paging.limit).map(c=>wire(c,row,person,generation)),page:{nextPage:results.length>paging.limit?paging.number+1:0}};
 }
 if (method==='CreateGitCredential') {
  const mode=typeof body.mode==='string'?['','GIT_CREDENTIAL_MODE_READ','GIT_CREDENTIAL_MODE_WRITE'].indexOf(body.mode):body.mode;
  const label=body.label,seconds=body.lifetimeSeconds;
  if (typeof label!=='string' || !label || label.trim()!==label || new TextEncoder().encode(label).length>64 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label) || new TextDecoder().decode(new TextEncoder().encode(label))!==label || ![1,2].includes(mode) || !Number.isInteger(seconds) || seconds<300 || seconds>3600) invalid('Use a trimmed name up to 64 bytes, read/write access and a lifetime of 5–60 minutes.');
  if(mode===2 && !['write','admin'].includes(row.role))deny();
  const secret='golf_git_'+btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const hash=await digest(secret),now=Math.floor(Date.now()/1000);
  const saved=await db.prepare(`INSERT INTO git_credentials(digest,user_id,repository_id,artifact_name,label,mode,identity_version,grant_generation,created_at,expires_at)
   SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard} AND (SELECT COUNT(*) FROM git_credentials WHERE user_id=? AND revoked_at IS NULL AND expires_at>${nowSQL})<100`)
   .bind(hash,person.id,row.id,row.artifact_name,label,mode,person.identity_version||0,generation,now,now+seconds,...values,person.id).run();
  if(saved.meta.changes!==1)throw new Fault('failed_precondition',412,'Access changed or the account has 100 unexpired credentials. Refresh and revoke unused credentials.');
  const c=await db.prepare('SELECT * FROM git_credentials WHERE digest=?').bind(hash).first();await current();
  return {credential:wire(c,row,person,generation),secret};
 }
 if (method==='RevokeGitCredential') {
  if(typeof body.credentialId!=='string' || !/^[1-9][0-9]{0,18}$/.test(body.credentialId) || BigInt(body.credentialId)>9223372036854775807n)invalid('Choose the original Git credential ID.');
  const revoked=await db.prepare(`UPDATE git_credentials SET revoked_at=COALESCE(revoked_at,${nowSQL}) WHERE id=? AND repository_id=? AND user_id=? AND ${guard}`).bind(body.credentialId,row.id,person.id,...values).run();
  if(revoked.meta.changes!==1)deny();return {credentialId:body.credentialId,revoked:true};
 }
 deny();
}
