import { digest, deny, invalid, Fault, uuidOK } from './common.mjs';
import { repositoryAccess } from './repository-settings.mjs';

export const ruleMethods = new Set(['GetRepositoryRules','MutateRepositoryRules','GetRepositoryRuleMutation']);
const actions = ['', 'CREATE_BRANCH','EDIT_BRANCH','REMOVE_BRANCH','CREATE_TAG','EDIT_TAG','REMOVE_TAG','EDIT_MERGE'];
const revisionOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value)<=9223372036854775807n;
const locked = () => { throw new Fault('permission_denied',403,'Repository rules prohibit this Git update.'); };
const stale = () => { throw new Fault('failed_precondition',412,'Repository rules or access changed. Refresh before editing.'); };

// Literal names and a single trailing * are deliberate; no regex/glob ambiguity at the write boundary.
export function rulePattern(value) {
  if (typeof value !== 'string' || value.length>200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\*?$/.test(value) && value!=='*' || value.includes('..') || value.includes('//') || value.split('/').some(part=>!part || part.startsWith('.') || part.endsWith('.') || part.replace(/\*$/,'').endsWith('.lock'))) invalid('Use a literal ref name or prefix followed by one trailing * (up to 200 characters).');
  return value;
}
const matches = (pattern, name) => pattern.endsWith('*') ? name.startsWith(pattern.slice(0,-1)) : name===pattern;
// Whether any stored tag rule names this tag (release publication refuses such tags).
export const tagRuled = (tags, name) => tags.some(rule=>matches(rulePattern(rule.namePattern),name));
function branch(value, createdAt, time) {
  if (!value || typeof value!=='object' || Array.isArray(value)) invalid('Choose a branch lock.');
  const allowed = new Set(['ruleName','priority','requiredApprovals','blockAdminMergeOverride','createdAt','updatedAt']);
  for (const [key,v] of Object.entries(value)) if (!allowed.has(key) && v!==false && v!=='' && !(Array.isArray(v) && !v.length)) invalid('Native branch rules currently lock all matching writes. Push exceptions, reviews, checks and signing policy are not supported.');
  if (value.priority!=='1' || (value.requiredApprovals||'0')!=='0' || value.blockAdminMergeOverride!==true || value.createdAt || value.updatedAt) invalid('Native branch locks require priority 1, zero approval count and no admin bypass.');
  return {ruleName:rulePattern(value.ruleName),priority:'1',requiredApprovals:'0',blockAdminMergeOverride:true,createdAt,updatedAt:time};
}
function tag(value, id, createdAt, time) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!['id','namePattern','allowedUsernames','allowedTeams','createdAt','updatedAt'].includes(key)) || value.id || value.createdAt || value.updatedAt || value.allowedTeams!==undefined && (!Array.isArray(value.allowedTeams) || value.allowedTeams.length)) invalid('Native tag rules support enrolled account names, not teams.');
  const names=value.allowedUsernames===undefined?[]:value.allowedUsernames;
  if (!Array.isArray(names) || names.length>100 || new Set(names).size!==names.length || names.some(v=>typeof v!=='string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(v))) invalid('Choose at most 100 distinct enrolled account names. An empty list locks the matching tags.');
  return {id,namePattern:rulePattern(value.namePattern),allowedUsernames:[...names].sort(),allowedTeams:[],createdAt,updatedAt:time};
}
async function document(db,row) {
  const stored=await db.prepare('SELECT * FROM repository_rules WHERE repository_id=?').bind(row.id).first();
  if (stored && stored.artifact_name!==row.artifact_name) throw new Fault('failed_precondition',412,'Repository rule identity changed.');
  return stored ? {...stored,branches:JSON.parse(stored.branches),tags:JSON.parse(stored.tags)} : {version:0,branches:[],tags:[],next_tag:1};
}
async function inventory(row,access,d) {
  return {repositoryId:String(row.id),ownerId:String(row.workspace_id),accessRevision:access.revision,
    rulesRevision:await digest(JSON.stringify(['native.rules.v1',row.id,row.artifact_name,d.version,d.branches,d.tags,d.next_tag])),
    branchProtections:d.branches,tagProtections:d.tags.map(({allowedActors,...rule})=>rule),mergeConfiguration:{defaultMergeStyle:'merge',defaultUpdateStyle:'merge'}};
}
function adminGuard(person,row,version=false) {
  return {sql:`EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
    LEFT JOIN native_identity_versions v ON v.user_id=u.id LEFT JOIN repository_access_versions a ON a.repository_id=r.id
    WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND g.role='admin' AND u.active=1 AND COALESCE(v.version,0)=? ${version?'AND COALESCE(a.version,0)=? AND r.write_pending IS NULL AND NOT EXISTS(SELECT 1 FROM git_ref_unknown k WHERE k.repository_id=r.id)':''})`,
    values:[row.id,row.artifact_name,person.id,person.identity_version||0,...(version?[row.access_version||0]:[])]};
}
async function requireAdmin(db,person,row) {
  const guard=adminGuard(person,row);
  if (!await db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values).first()) deny();
}
export async function repositoryRules(db,env,person,row,request,method,body) {
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') || row.role!=='admin' || body.repositoryId!==String(row.id) || body.ownerId!==String(row.workspace_id)) deny();
  const {access}=await repositoryAccess(db,env,person,row);
  if (method==='GetRepositoryRules') {
    if (body.expectedRevision!==access.revision) stale();
    const result=await inventory(row,access,await document(db,row));await requireAdmin(db,person,row);return result;
  }
  if (!uuidOK(body.operationId)) invalid('Use the original UUID v4 rule operation ID.');
  const action=typeof body.action==='string'?actions.indexOf(body.action.replace(/^REPOSITORY_RULE_MUTATION_ACTION_/,'')):body.action;
  if (method==='MutateRepositoryRules' && (!Number.isInteger(action) || action<1 || action>7 || !revisionOK(body.expectedAccessRevision) || !revisionOK(body.expectedRulesRevision))) invalid('Choose a rule action with the observed access and rules revisions.');
  const fingerprint=method==='MutateRepositoryRules'?await digest(JSON.stringify([row.id,row.artifact_name,person.id,action,body.expectedAccessRevision,body.expectedRulesRevision,body.ruleName||'',body.tagId||'',body.desiredBranch||null,body.desiredTag||null,body.desiredMerge||null])):null;
  const original=await db.prepare('SELECT * FROM repository_rule_operations WHERE operation_id=?').bind(body.operationId).first();
  if (original) {
    await requireAdmin(db,person,row);
    if (original.actor_id!==person.id || original.repository_id!==row.id) deny();
    if (fingerprint && original.input_hash!==fingerprint) throw new Fault('already_exists',409,'Rule operation ID belongs to a different request.');
    return {operation:JSON.parse(original.receipt),...(method==='MutateRepositoryRules' && original.current_rules?{currentRules:JSON.parse(original.current_rules)}:{})};
  }
  if (method==='GetRepositoryRuleMutation') deny();
  const current=await document(db,row), before=await inventory(row,access,current), next={...current,version:current.version+1,branches:[...current.branches],tags:[...current.tags]};
  const time=new Date().toISOString();let valid=true;
  try {
    if (action===7 || body.expectedAccessRevision!==access.revision || body.expectedRulesRevision!==before.rulesRevision || row.write_pending) stale();
    if ([1,2,3].includes(action)) {
      if (body.desiredTag || body.desiredMerge || body.tagId || action===3 && body.desiredBranch) invalid('Choose only the branch action payload.');
      const index=next.branches.findIndex(value=>value.ruleName===body.ruleName);
      if (action===1 ? next.branches.length>=100 : index<0) stale();
      if (action===3) next.branches.splice(index,1);
      else {
        const rule=branch(body.desiredBranch,index>=0?next.branches[index].createdAt:time,time);
        if (rule.ruleName!==body.ruleName || action===1 && next.branches.some(value=>value.ruleName===rule.ruleName)) stale();
        if (action===1) next.branches.push(rule);else next.branches[index]=rule;
        next.branches.sort((a,b)=>a.ruleName.localeCompare(b.ruleName,'en'));
      }
    } else {
      if (body.desiredBranch || body.desiredMerge || body.ruleName || action===6 && body.desiredTag) invalid('Choose only the tag action payload.');
      const index=next.tags.findIndex(value=>value.id===body.tagId);
      if (action===4 ? Boolean(body.tagId) || next.tags.length>=100 : !positive(body.tagId) || index<0) stale();
      if (action===6) next.tags.splice(index,1);
      else {
        const rule=tag(body.desiredTag,index>=0?next.tags[index].id:String(next.next_tag++),index>=0?next.tags[index].createdAt:time,time);
        if (action===4 && next.tags.some(value=>value.namePattern===rule.namePattern) || action===5 && rule.namePattern!==next.tags[index].namePattern) stale();
        rule.allowedActors=[];
        if (rule.allowedUsernames.length) {
          const {results:accounts}=await db.prepare(`SELECT id,login FROM users WHERE active=1 AND login IN (${rule.allowedUsernames.map(()=>'?').join(',')})`).bind(...rule.allowedUsernames).all();
          if (accounts.length!==rule.allowedUsernames.length) invalid('Tag allowlists require enrolled active accounts.');
          const ids=new Map(accounts.map(account=>[account.login,account.id]));
          rule.allowedActors=rule.allowedUsernames.map(name=>ids.get(name));
        }
        if (action===4) next.tags.push(rule);else next.tags[index]=rule;
      }
    }
  } catch (error) {if (!(error instanceof Fault)) throw error;valid=false;}
  const after=valid?await inventory(row,access,next):null;
  const base={operationId:body.operationId,repository:body.repository,repositoryId:String(row.id),ownerId:String(row.workspace_id),actorId:String(person.id),action,
    expectedAccessRevision:body.expectedAccessRevision,expectedRulesRevision:body.expectedRulesRevision,inputFingerprint:fingerprint,createdAt:time,updatedAt:time};
  const success={...base,phase:'SUCCEEDED',observedRulesRevision:after?.rulesRevision,failureCode:''},refused={...base,phase:'REJECTED',failureCode:'preflight_refused'};
  const effect=adminGuard(person,row,true), receipt=adminGuard(person,row);
  const statements=[];
  if (valid) statements.push(db.prepare(`INSERT INTO repository_rules(repository_id,artifact_name,version,branches,tags,next_tag)
    SELECT ?,?,?,?,?,? WHERE ${effect.sql} AND COALESCE((SELECT version FROM repository_rules WHERE repository_id=?),0)=?
    ON CONFLICT(repository_id) DO UPDATE SET version=excluded.version,branches=excluded.branches,tags=excluded.tags,next_tag=excluded.next_tag WHERE repository_rules.version=? AND repository_rules.artifact_name=excluded.artifact_name`)
    .bind(row.id,row.artifact_name,next.version,JSON.stringify(next.branches),JSON.stringify(next.tags),next.next_tag,...effect.values,row.id,current.version,current.version));
  statements.push(db.prepare(`INSERT INTO repository_rule_operations(operation_id,repository_id,actor_id,input_hash,receipt,current_rules)
    SELECT ?,?,?,?,CASE WHEN ${valid?'changes()=1':'0'} THEN ? ELSE ? END,CASE WHEN ${valid?'changes()=1':'0'} THEN ? ELSE NULL END WHERE ${receipt.sql}`)
    .bind(body.operationId,row.id,person.id,fingerprint,JSON.stringify(success),JSON.stringify(refused),after?JSON.stringify(after):null,...receipt.values));
  const results=await db.batch(statements);
  if (!results.at(-1).meta.changes) deny();
  const saved=await db.prepare('SELECT receipt,current_rules FROM repository_rule_operations WHERE operation_id=?').bind(body.operationId).first();
  return {operation:JSON.parse(saved.receipt),...(saved.current_rules?{currentRules:JSON.parse(saved.current_rules)}:{})};
}

export async function enforceGitRules(db,row,person,ref) {
  const d=await document(db,row), branch=ref.startsWith('refs/heads/'), name=ref.slice(branch?11:10);
  if (branch && d.branches.some(rule=>matches(rulePattern(rule.ruleName),name))) locked();
  if (!branch && d.tags.some(rule=>matches(rulePattern(rule.namePattern),name) && !rule.allowedActors?.includes(person.id))) locked();
  return d.version;
}

export async function branchLockObservation(db,row,name) {
  const d=await document(db,row);
  return { version:d.version, locked:d.branches.some(rule=>matches(rulePattern(rule.ruleName),name)) };
}
