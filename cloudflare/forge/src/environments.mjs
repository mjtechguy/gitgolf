import { ownerSlug } from './owners.mjs';
import { validRef } from './git.mjs';
import { digest, deny, invalid, Fault, page, uuidOK } from './common.mjs';
import { repositoryAccess, settingsAuthority } from './repository-settings.mjs';

export const environmentMethods = new Set(['ListRepositoryEnvironments','SaveRepositoryEnvironment','DeleteRepositoryEnvironment','GetRepositoryEnvironmentOperation']);
// The workspace holds at most this many unpurged previews, so a larger repository limit could never apply.
export const previewSlots = 4;
const capability = 'REPOSITORY_ENVIRONMENT_CAPABILITY_PREVIEW_POLICY';
const revisionOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const versionOK = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,14})$/.test(value);
// Definite refusals before any write; the settings page offers to discard an aborted change.
const stale = () => { throw new Fault('aborted',409,'Environment or repository access changed; inspect the current configuration before a new action.'); };
const live = (db,row) => db.prepare(`SELECT e.artifact_name,v.* FROM repository_environments e JOIN repository_environment_versions v ON v.environment_id=e.id AND v.version=e.version
  WHERE e.repository_id=? AND e.deleted=0`).bind(row.id).first();

// Only fields with a consumer are accepted: head branches, preview lifetime and concurrent previews.
function policy(value) {
  const fields = ['allowAllSources','sources','reviewers','requiredApprovals','preventSelfApproval','allowAdminBypass','waitSeconds','maxConcurrency','protectedPreviews','previewTtlSeconds'];
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!fields.includes(key))) invalid('Provide the preview environment policy.');
  if (value.reviewers!==undefined && (!Array.isArray(value.reviewers) || value.reviewers.length) || (value.requiredApprovals??0)!==0 || (value.waitSeconds??0)!==0 || (value.allowAdminBypass??false)!==false)
    invalid('Required reviewers, approvals, wait timers and administrator bypass are not available on this installation.');
  if (value.preventSelfApproval!==true || value.protectedPreviews!==true) invalid('The preview environment governs protected previews only.');
  const sources = value.sources??[], all = value.allowAllSources??false;
  if (!Array.isArray(sources) || sources.length>20 || typeof all!=='boolean' || all!==(sources.length===0)) invalid('Allow every head branch or list up to 20 exact branch names.');
  const names = sources.map(source=>{
    if (!source || typeof source!=='object' || Object.keys(source).some(key=>!['kind','name'].includes(key)) || ![2,'REPOSITORY_SOURCE_REF_KIND_BRANCH'].includes(source.kind))
      invalid('The preview environment accepts exact branch names only; tag, commit and default-branch selectors are not available on this installation.');
    if (typeof source.name!=='string' || !validRef('refs/heads/'+source.name)) invalid('Use exact branch names without wildcards.');
    return source.name;
  });
  if (new Set(names).size!==names.length) invalid('Branch names must be unique.');
  if (!Number.isInteger(value.maxConcurrency) || value.maxConcurrency<1 || value.maxConcurrency>previewSlots) invalid(`Concurrent previews must be between 1 and ${previewSlots} on this installation.`);
  if (!Number.isInteger(value.previewTtlSeconds) || value.previewTtlSeconds<60 || value.previewTtlSeconds>14400) invalid('Preview lifetime must be between 60 and 14400 seconds.');
  return {allowAllSources:all,sources:names.map(name=>({kind:'REPOSITORY_SOURCE_REF_KIND_BRANCH',name})),reviewers:[],requiredApprovals:0,preventSelfApproval:true,allowAdminBypass:false,waitSeconds:0,
    maxConcurrency:value.maxConcurrency,protectedPreviews:true,previewTtlSeconds:value.previewTtlSeconds};
}
const wire = v => ({id:v.environment_id,target:JSON.parse(v.target),name:v.name,version:String(v.version),policy:JSON.parse(v.policy),creatorId:String(v.creator_id),updaterId:String(v.actor_id),
  createdAt:v.environment_created_at,updatedAt:v.created_at,deleted:Boolean(v.deleted),capability,deploymentAvailable:false});
// The receipt is the accepted version itself, never a later observation.
async function receipt(db,person,row,operationId,fingerprint) {
  const op = await db.prepare(`SELECT o.*,v.name,v.deleted,v.policy,v.target,v.creator_id,v.environment_created_at FROM repository_environment_operations o
    JOIN repository_environment_versions v ON v.environment_id=o.environment_id AND v.version=o.version WHERE o.operation_id=?`).bind(operationId).first();
  if (!op) return null;
  if (op.actor_id!==person.id || op.repository_id!==row.id) deny();
  if (fingerprint && op.input_hash!==fingerprint) throw new Fault('failed_precondition',412,'The original environment operation does not match this request.');
  const environment = wire(op);
  return {operation:{operationId:op.operation_id,environmentId:op.environment_id,target:environment.target,actorId:String(op.actor_id),action:'REPOSITORY_ENVIRONMENT_ACTION_'+op.action.toUpperCase(),
    expectedVersion:String(op.expected_version),version:String(op.version),state:'SUCCEEDED',createdAt:op.created_at},environment};
}

export async function repositoryEnvironments(db,env,person,row,request,method,body) {
  const t = body.target, ceiling = Number(env.PREVIEW_TTL);
  // Native has no account password: every call needs a verified human Access sign-in, never a bearer or service token.
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') || row.role!=='admin' ||
      !t || t.repositoryId!==String(row.id) || t.ownerId!==String(row.workspace_id)) deny();
  if (!revisionOK(t.accessRevision) || Object.keys(t).some(key=>!['repository','repositoryId','ownerId','accessRevision'].includes(key))) invalid('Provide the current repository environment target.');
  if (!Number.isInteger(ceiling) || ceiling<60 || ceiling>14400) throw new Fault('failed_precondition',412,'An operator-approved preview lifetime is required.');
  const authority = settingsAuthority(person,row), {access} = await repositoryAccess(db,env,person,row);
  const admitted = async () => { if (!await db.prepare(`SELECT 1 AS allowed WHERE ${authority.sql}`).bind(...authority.values).first()) deny(); };
  const changed = () => { throw new Fault('failed_precondition',412,'Repository access changed. Refresh before reading environments.'); };
  const target = {repository:{owner:ownerSlug(row,env),name:row.name},repositoryId:String(row.id),ownerId:String(row.workspace_id),accessRevision:t.accessRevision};
  if (method==='ListRepositoryEnvironments') {
    const paging = page(body);
    if (paging.limit>20) invalid('Environment inventory page size is at most 20.');
    if (t.accessRevision!==access.revision) changed();
    const current = await live(db,row);await admitted();
    if (current && current.artifact_name!==row.artifact_name) throw new Fault('failed_precondition',412,'Repository environment identity changed.');
    return {target,environments:current && paging.number===1?[wire(current)]:[],page:{nextPage:0},totalCount:current?'1':'0',capability,deploymentAvailable:false};
  }
  if (!uuidOK(body.operationId)) invalid('Use the original UUID v4 environment operation ID.');
  if (method==='GetRepositoryEnvironmentOperation') {
    if (t.accessRevision!==access.revision) changed();
    const original = await receipt(db,person,row,body.operationId);await admitted();
    if (!original) throw new Fault('not_found',404,'Original environment operation not available.');
    return original;
  }
  const remove = method==='DeleteRepositoryEnvironment', expected = Number(body.expectedVersion);
  if (Object.keys(body).some(key=>!['target','environmentId','expectedVersion','operationId','currentPassword',...(remove?[]:['name','policy'])].includes(key)) || !uuidOK(body.environmentId) || !versionOK(body.expectedVersion) || remove && expected<1)
    invalid('Provide canonical environment and operation IDs with the current version.');
  if (body.currentPassword) invalid('This installation has no account passwords; changes use your verified Access sign-in.');
  if (!remove && body.name!=='preview') invalid('This installation supports one environment named preview, which governs protected pull-request previews.');
  const desired = remove?null:policy(body.policy);
  const fingerprint = await digest(JSON.stringify([method,row.id,row.artifact_name,person.id,target,body.environmentId,body.expectedVersion,desired]));
  // Replay never repeats the mutation and does not need the original access revision to be current again.
  const original = await receipt(db,person,row,body.operationId,fingerprint);
  if (original) { await admitted();return original; }
  if (desired && desired.previewTtlSeconds>ceiling) invalid(`Preview lifetime must be between 60 and ${ceiling} seconds on this installation.`);
  if (t.accessRevision!==access.revision) stale();
  const prior = await db.prepare('SELECT * FROM repository_environments WHERE id=?').bind(body.environmentId).first(), current = await live(db,row);
  if (expected===0) { if (prior || current) stale(); }
  else if (!prior || prior.repository_id!==row.id) throw new Fault('not_found',404,'Environment unavailable.');
  else if (prior.deleted || prior.version!==expected || prior.artifact_name!==row.artifact_name || current?.environment_id!==prior.id) stale();
  if ((await db.prepare('SELECT count(*) AS total FROM repository_environment_operations WHERE repository_id=?').bind(row.id).first()).total>=(remove?1000:900))
    throw new Fault('resource_exhausted',429,'Environment operation retention limit reached; inspect retained configuration.');
  const time = new Date().toISOString();
  // One D1 transaction: the version and its receipt exist only if the fenced environment row changed under current admin authority.
  const results = await db.batch([expected===0
    ? db.prepare(`INSERT INTO repository_environments(id,repository_id,artifact_name,name,version,deleted) SELECT ?,?,?,'preview',1,0 WHERE ${authority.sql}
        AND NOT EXISTS(SELECT 1 FROM repository_environments WHERE id=? OR repository_id=? AND deleted=0)`).bind(body.environmentId,row.id,row.artifact_name,...authority.values,body.environmentId,row.id)
    : db.prepare(`UPDATE repository_environments SET version=version+1,deleted=? WHERE id=? AND repository_id=? AND artifact_name=? AND version=? AND deleted=0 AND ${authority.sql}`)
        .bind(remove?1:0,body.environmentId,row.id,row.artifact_name,expected,...authority.values),
    db.prepare(`INSERT INTO repository_environment_versions(environment_id,version,repository_id,name,deleted,policy,target,creator_id,actor_id,environment_created_at,created_at)
      SELECT ?,?,?,'preview',?,?,?,?,?,?,? WHERE changes()=1`).bind(body.environmentId,expected+1,row.id,remove?1:0,remove?current.policy:JSON.stringify(desired),JSON.stringify(target),
        current?current.creator_id:person.id,person.id,current?current.environment_created_at:time,time),
    db.prepare(`INSERT INTO repository_environment_operations(operation_id,repository_id,actor_id,environment_id,version,action,expected_version,input_hash,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1`).bind(body.operationId,row.id,person.id,body.environmentId,expected+1,remove?'delete':'save',expected,fingerprint,time)]);
  if (results[0].meta.changes!==1) { await admitted();stale(); }
  const saved = await receipt(db,person,row,body.operationId,fingerprint);
  if (!saved) throw Error('Environment receipt requires inspection');
  return saved;
}

// Publication and renewal read the stored policy; no environment means only the operator allocation applies.
export async function previewEnvironment(db,row) {
  const current = await live(db,row);
  if (current && current.artifact_name!==row.artifact_name) throw new Fault('failed_precondition',412,'Repository environment identity changed.');
  return current?{revision:`${current.environment_id}:${current.version}`,policy:JSON.parse(current.policy)}:{revision:'',policy:null};
}
// Bind (repository id, observed revision): a preview write commits only under the policy it was checked against.
export const previewEnvironmentGuard = "COALESCE((SELECT id||':'||version FROM repository_environments WHERE repository_id=? AND deleted=0),'')=?";
export const branchAllowed = (policy,branch) => policy.allowAllSources || typeof branch==='string' && policy.sources.some(source=>source.name===branch);
