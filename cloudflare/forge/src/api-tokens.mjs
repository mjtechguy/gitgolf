// API tokens for agents (docs/AGENT_ACCESS.md, AM-3): golf_pat_ bearer secrets accepted on /mcp, /native/source/* and /git/* only,
// stored as SHA-256. A token carries a scope (repositories, read or write, a write branch pattern) and never more than its owner's
// current grant: authorizedRepository caps the role and the push reservation re-checks the token row in the same statement.
// An agent-host task token (golf_agent_task_, docs/AGENT_HOSTS.md) is accepted the same way on /mcp and /native/source/* only, as the
// task's requester scoped to the task's repository and exactly its branch, while the task runs.
import { digest, Fault, invalid } from './common.mjs';
import { ownerColumns, ownerJoin, ownerSlug } from './owners.mjs';
import { budgetPolicy } from './agent-budgets.mjs';

export const tokenPrefix = 'golf_pat_';
const secretPattern = /^golf_pat_[A-Za-z0-9_-]{43}$/, taskPattern = /^golf_agent_task_([0-9a-f-]{36})_[0-9a-f]{64}$/;
const nowSQL = "CAST(strftime('%s','now') AS INTEGER)";
export const gitRoute = /^\/git\/[^/]+\/[^/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;
const unauthenticated = message => { throw new Fault('unauthenticated', 401, message); };
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const iso = value => value ? new Date(value * 1000).toISOString() : '';
const seconds = () => Math.floor(Date.now() / 1000);

// The secret in a request: Bearer anywhere, or Basic (any user name, token as password) because Git clients send Basic.
// A task token counts only as a Bearer ({ task: id }); its own Git route (agent-host-protocol.mjs) reads it there, never through here.
export function apiTokenSecret(authorization) {
  if (secretPattern.test(authorization.slice(7)) && authorization.startsWith('Bearer ')) return { secret: authorization.slice(7), basic: false };
  const task = authorization.startsWith('Bearer ') && taskPattern.exec(authorization.slice(7));
  if (task) return { secret: authorization.slice(7), basic: false, task: task[1] };
  if (!authorization.startsWith('Basic ') || authorization.length > 512) return null;
  try {
    const decoded = atob(authorization.slice(6)), match = /^[^:\x00-\x1f]{0,128}:(golf_pat_[A-Za-z0-9_-]{43})$/.exec(decoded);
    return match && btoa(decoded) === authorization.slice(6) ? { secret: match[1], basic: true } : null;
  } catch { return null; }
}
// A capacity metrics token (capacity.mjs, docs/RUNNER_CAPACITY.md): read-only queue depth for autoscalers, on that one route only.
export const capacityTokenPattern = /^golf_capacity_[A-Za-z0-9_-]{43}$/;
// Routes a token reaches from outside: the public Worker skips Access for exactly these when one is presented.
export function machineTokenRoute(path, authorization) {
  if (path === '/native/capacity/metrics') return (authorization || '').startsWith('Bearer ') && capacityTokenPattern.test(authorization.slice(7));
  const token = apiTokenSecret(authorization || '');
  return Boolean(token) && (!token.task && gitRoute.test(path) || !token.basic && (path === '/mcp' || path.startsWith('/native/source/')));
}
// The rate budget a token caller is counted under (agent-budgets.mjs): [kind, id], or null for people and other credentials.
export const budgetSubject = person => person.api_token_id ? ['token', person.api_token_id] : person.agent_task_id ? ['task', person.agent_task_id] : null;
// Repository routes the MCP tools call as internal requests (env.mcpInternal, set only by mcp.mjs), with the class each needs.
export const mcpRoutes = new Map([
  ...['GetRepository', 'GetRepositoryOverview', 'ResolveRepositorySource', 'ListCommits', 'GetRepositoryComparison', 'GetIssue', 'ListIssues', 'ListIssueComments',
    'GetPullRequest', 'GetPullRequestDiscussion', 'GetPullRequestDiff'].map(method => ['/rpc/golf.v1.RepositoryService/' + method, 'read']),
  ['/native/search/read', 'read'], ['/native/pipelines', 'read'],
  ['/rpc/golf.v1.RepositoryService/CreatePullRequest', 'write'], ['/rpc/golf.v1.RepositoryService/CreateIssueComment', 'write'],
]);

// The schema 39 table; an installation that has not migrated says so instead of failing a query.
let migrated = false;
export async function apiTokenSchema(db) {
  if (!migrated) migrated = Boolean((await db.prepare('PRAGMA table_info(api_tokens)').all()).results.length);
  return migrated;
}
export async function apiTokenCapability(db) {
  const ready = await apiTokenSchema(db);
  return { id: 'agents.mcp', label: 'API tokens and remote MCP', state: ready ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED',
    reason: ready ? 'Personal golf_pat_ tokens, scoped to repositories, read or write and an optional write branch pattern, for the remote MCP endpoint /mcp, the Source API and HTTPS Git. A token never exceeds its owner’s current access; changing account access revokes it.'
      : 'Apply the schema 39 migration to issue API tokens.' };
}

export async function apiTokenActor(db, request, token, env) {
  if (token.task) return taskTokenActor(db, request, token, env);
  const path = new URL(request.url).pathname, internal = env.mcpInternal === true;
  if (token.basic ? !gitRoute.test(path) : !(path === '/mcp' || path.startsWith('/native/source/') || gitRoute.test(path) || internal && mcpRoutes.has(path)))
    unauthenticated('API tokens are accepted only on /mcp, /native/source/ and /git/.');
  const now = seconds(), row = await db.prepare(`SELECT t.id AS api_token_id,t.digest,t.repositories,t.permission,t.branch_pattern,t.last_used_at,u.id,u.login,u.email,u.active,u.can_create,
    COALESCE(v.version,0) AS identity_version,COALESCE(p.full_name,u.full_name) AS full_name FROM api_tokens t JOIN users u ON u.id=t.user_id
    LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
    WHERE t.digest=? AND t.revoked_at IS NULL AND t.expires_at>? AND u.active=1 AND t.identity_version=COALESCE(v.version,0)`).bind(await digest(token.secret), now).first();
  if (!row) unauthenticated('Valid, unexpired API token required.');
  if (internal && mcpRoutes.get(path) === 'write' && row.permission !== 'write') forbidden('This API token is read-only.');
  // At most one write a minute per token; a failure never refuses the request.
  if (!row.last_used_at || row.last_used_at <= now - 60)
    try { await db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<=?)').bind(now, row.api_token_id, now - 60).run(); } catch { /* best effort */ }
  return { id: row.id, login: row.login, email: row.email, active: row.active, can_create: row.can_create, identity_version: row.identity_version, full_name: row.full_name,
    api_token_digest: row.digest, api_token_id: row.api_token_id, api_token_route: path, token_guard: tokenGuard(row.digest, row.id),
    token_scope: { repositories: row.repositories === null ? null : JSON.parse(row.repositories), permission: row.permission, branchPattern: row.branch_pattern } };
}

// An agent task token: the requester, scoped to the task's repository and exactly its branch, while the task is RUNNING, not
// cancel-requested and before its deadline, and while the requester still writes there. token_guard re-checks all of that inside
// every write reservation. Never on /git/ (the task has its own Git route) and nowhere else.
async function taskTokenActor(db, request, token, env) {
  const path = new URL(request.url).pathname, internal = env.mcpInternal === true;
  if (!(path === '/mcp' || path.startsWith('/native/source/') || internal && mcpRoutes.has(path)))
    unauthenticated('Agent task tokens are accepted only on /mcp, /native/source/ and the task’s own agent host routes.');
  const row = await db.prepare(`SELECT t.id AS agent_task_id,t.token_digest,t.repository_id,t.branch,t.target_kind,t.target_number,t.state,t.cancel_requested,t.deadline,
    u.id,u.login,u.email,u.active,u.can_create,COALESCE(v.version,0) AS identity_version,COALESCE(p.full_name,u.full_name) AS full_name,
    EXISTS(SELECT 1 FROM grants g WHERE g.repository_id=t.repository_id AND g.user_id=t.requested_by AND g.role IN ('write','admin')) AS writer
    FROM agent_tasks t JOIN users u ON u.id=t.requested_by JOIN repositories r ON r.id=t.repository_id AND r.artifact_name=t.artifact_name AND r.state='ACTIVE'
    LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
    WHERE t.token_digest=? AND t.id=? AND u.active=1`).bind(await digest(token.secret), token.task).first();
  if (!row) unauthenticated('Task token unknown.');
  if (row.state !== 'RUNNING' || row.cancel_requested || row.deadline <= Date.now()) unauthenticated('A task token works on /mcp and /native/source/ only while its task is running.');
  if (!row.writer) forbidden('The task’s requester no longer has write access to its repository.');
  return { id: row.id, login: row.login, email: row.email, active: row.active, can_create: row.can_create, identity_version: row.identity_version, full_name: row.full_name,
    agent_task_id: row.agent_task_id, agent_task: { branch: row.branch, target: { kind: row.target_kind, number: row.target_number } },
    api_token_route: path, token_guard: taskGuard(row.agent_task_id, row.token_digest, row.id),
    token_scope: { repositories: [String(row.repository_id)], permission: 'write', branchPattern: row.branch, label: 'agent task token' } };
}
// person.token_guard for a task token (self-contained like tokenGuard): the task still running with this token, before its deadline,
// and its requester still an active writer of its repository.
const taskGuard = (taskId, digestValue, userId) => ({ sql: `EXISTS(SELECT 1 FROM agent_tasks tt JOIN grants tg ON tg.repository_id=tt.repository_id AND tg.user_id=tt.requested_by
  JOIN users tu ON tu.id=tt.requested_by WHERE tt.id=? AND tt.token_digest=? AND tt.requested_by=? AND tt.state='RUNNING' AND tt.cancel_requested=0
  AND tt.deadline>${nowSQL}*1000 AND tg.role IN ('write','admin') AND tu.active=1)`, values: [taskId, digestValue, userId] });

// A pattern is an exact branch name or a prefix ending in '*'. Tags and other refs never match a pattern.
export function branchAllowed(pattern, ref) {
  if (!pattern) return true;
  if (!ref.startsWith('refs/heads/')) return false;
  const branch = ref.slice(11);
  return pattern.endsWith('*') ? branch.startsWith(pattern.slice(0, -1)) : branch === pattern;
}

// Every refusal of a valid token by its own scope is audited at repository scope; the row never holds the token.
async function refused(db, env, person, row, reason, message) {
  try {
    const fullName = `${ownerSlug(row, env)}/${row.name}`;
    await db.prepare(`INSERT INTO installation_audit(at,actor_id,actor_email,scope,scope_id,subject,action,before,after,widening,operation_id,client) VALUES(?,?,'','repository',?,?,'api_token.use_denied',NULL,?,0,NULL,?)`)
      .bind(new Date().toISOString(), person.id, String(row.id), fullName, JSON.stringify(person.agent_task_id ? { agentTaskId: person.agent_task_id, reason } : { tokenId: String(person.api_token_id), reason }),
        JSON.stringify({ via: person.agent_task_id ? 'agent_task' : 'api_token', login: person.login, outcome: 'denied', code: 'permission_denied', repository: fullName, route: String(person.api_token_route || '').slice(0, 120) })).run();
  } catch { console.log(JSON.stringify({ event: 'golf.audit_write_failed', action: 'api_token.use_denied' })); }
  forbidden(message);
}
// The repository row a token may use: in scope. row.role stays the owner's actual grant, because authority re-checks compare it with
// the stored grant (g.role=?); the token's permission is enforced where writes enter (scopePush, the Source API's requireScope and the
// MCP write tools), and a token never reaches an administration route at all.
export async function scopeRepository(db, env, person, row) {
  const scope = person.token_scope;
  if (scope.repositories && !scope.repositories.includes(String(row.id))) await refused(db, env, person, row, 'repository', `This ${scope.label || 'API token'} does not cover this repository.`);
}
// A push: the token must be a write token and the ref must match its branch pattern.
export async function scopePush(db, env, person, row, ref) {
  const scope = person.token_scope;
  if (scope.permission !== 'write') await refused(db, env, person, row, 'permission', 'This API token is read-only.');
  if (ref !== undefined && !branchAllowed(scope.branchPattern, ref)) await refused(db, env, person, row, 'branch', `This API token may push only to branches matching ${scope.branchPattern}.`);
}
// person.token_guard: ANDed (self-contained, no outer aliases) into every write reservation, /git/ pushes and the Source API alike,
// so a token revoked, expired or invalidated mid-request writes nothing.
const tokenGuard = (digestValue, userId) => ({ sql: `EXISTS(SELECT 1 FROM api_tokens t JOIN users tu ON tu.id=t.user_id LEFT JOIN native_identity_versions tv ON tv.user_id=t.user_id
  WHERE t.digest=? AND t.user_id=? AND t.permission='write' AND t.revoked_at IS NULL AND t.expires_at>${nowSQL} AND tu.active=1 AND t.identity_version=COALESCE(tv.version,0))`, values: [digestValue, userId] });

// ---------- user API: POST /native/api-tokens (Access-authenticated browser session only) ----------
const labelOK = label => typeof label === 'string' && label && label.trim() === label && new TextEncoder().encode(label).length <= 64 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(label);
const patternOK = pattern => pattern === '' || typeof pattern === 'string' && pattern.length <= 200 && /^[A-Za-z0-9._/-]+\*?$|^\*$/.test(pattern) && !pattern.startsWith('/') && !pattern.includes('..') && !pattern.includes('//') && !/(^|\/)\./.test(pattern) && !/\.lock(\/|\*?$)/.test(pattern);
const fields = (body, allowed) => Object.keys(body).every(key => allowed.includes(key));
const state = (t, person, now) => t.revoked_at ? 'revoked' : t.expires_at <= now ? 'expired' : t.identity_version !== (person.identity_version || 0) ? 'invalidated' : 'active';

async function repositoryNames(db, env, ids) {
  if (!ids.length) return new Map();
  const { results } = await db.prepare(`SELECT r.id,r.name,${ownerColumns} FROM repositories r ${ownerJoin} WHERE r.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids.map(Number))).all();
  return new Map(results.map(row => [String(row.id), `${ownerSlug(row, env)}/${row.name}`]));
}
function wire(t, person, names, now) {
  const repositories = t.repositories === null ? null : JSON.parse(t.repositories);
  return { id: String(t.id), label: t.label, permission: t.permission, branchPattern: t.branch_pattern, state: state(t, person, now),
    repositories: repositories && repositories.map(id => ({ id, fullName: names.get(id) || '' })),
    createdAt: iso(t.created_at), expiresAt: iso(t.expires_at), lastUsedAt: iso(t.last_used_at), revokedAt: iso(t.revoked_at) };
}

export async function apiTokensAPI(db, env, person, request, body) {
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') || request.headers.get('Origin') !== env.PUBLIC_ORIGIN)
    forbidden('Manage API tokens from a signed-in browser session.');
  if (!await apiTokenSchema(db)) throw new Fault('failed_precondition', 412, 'API tokens need the schema 39 migration on this installation.');
  const now = seconds(), version = person.identity_version || 0;
  if (body.action === 'list') {
    const { results } = await db.prepare('SELECT * FROM api_tokens WHERE user_id=? ORDER BY id DESC LIMIT 200').bind(person.id).all();
    const names = await repositoryNames(db, env, [...new Set(results.flatMap(t => t.repositories === null ? [] : JSON.parse(t.repositories)))]);
    const tokens = results.map(t => wire(t, person, names, now));
    // Rate budgets (agent-budgets.mjs): this workspace's current one-minute window for each token, or null where nothing counts.
    const policy = await budgetPolicy(env, db);
    if (policy) for (const token of tokens) token.usage = env.agentBudgets.usage('token', token.id);
    return { tokens, active: tokens.filter(t => t.state === 'active').length, limit: 50, mcpUrl: env.PUBLIC_ORIGIN + '/mcp', origin: env.PUBLIC_ORIGIN,
      budget: policy && { enabled: policy.enabled, requestsPerMinute: policy.tokenRequestsPerMinute, writesPerMinute: policy.tokenWritesPerMinute } };
  }
  if (body.action === 'repositories') {
    // The picker lists exactly what create accepts: active repositories this account holds a grant on (not public ones it does not
    // belong to), by owner then name, 100 a page.
    if (!fields(body, ['action', 'page'])) invalid('Unknown field.');
    const number = body.page ?? 1;
    if (!Number.isInteger(number) || number < 1 || number > 1000) invalid('Choose a page from 1 to 1000.');
    const { results } = await db.prepare(`SELECT r.id,r.name,${ownerColumns} FROM grants g JOIN repositories r ON r.id=g.repository_id ${ownerJoin}
      WHERE g.user_id=? AND r.state='ACTIVE' ORDER BY COALESCE(o.slug,?),r.name,r.id LIMIT 101 OFFSET ?`).bind(person.id, env.WORKSPACE_SLUG || '', (number - 1) * 100).all();
    return { repositories: results.slice(0, 100).map(row => ({ id: String(row.id), fullName: `${ownerSlug(row, env)}/${row.name}` })), nextPage: results.length > 100 ? number + 1 : 0 };
  }
  if (body.action === 'create') {
    if (!fields(body, ['action', 'label', 'repositories', 'permission', 'branchPattern', 'lifetimeHours'])) invalid('Unknown field.');
    const { label, repositories = null, permission, branchPattern = '', lifetimeHours } = body;
    if (!labelOK(label)) invalid('Use a trimmed name up to 64 bytes.');
    if (!['read', 'write'].includes(permission)) invalid('Choose read or write permission.');
    if (!Number.isInteger(lifetimeHours) || lifetimeHours < 1 || lifetimeHours > 2160) invalid('Choose a lifetime from 1 hour to 90 days.');
    if (!patternOK(branchPattern)) invalid('Use a branch name, or a prefix ending in *, for example agent/*.');
    if (branchPattern && permission !== 'write') invalid('A branch pattern limits writes; it applies only to write tokens.');
    if (repositories !== null && (!Array.isArray(repositories) || !repositories.length || repositories.length > 100 || new Set(repositories).size !== repositories.length || repositories.some(id => typeof id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(id))))
      invalid('Choose up to 100 repositories, or all repositories you can access.');
    if (repositories) {
      const found = await db.prepare("SELECT COUNT(*) AS n FROM grants g JOIN repositories r ON r.id=g.repository_id WHERE g.user_id=? AND r.state='ACTIVE' AND r.id IN (SELECT value FROM json_each(?))").bind(person.id, JSON.stringify(repositories.map(Number))).first();
      if (found.n !== repositories.length) invalid('Choose repositories you can access.');
    }
    const secret = tokenPrefix + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const hash = await digest(secret);
    const saved = await db.prepare(`INSERT INTO api_tokens(digest,user_id,label,repositories,permission,branch_pattern,identity_version,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users u LEFT JOIN native_identity_versions v ON v.user_id=u.id WHERE u.id=? AND u.active=1 AND COALESCE(v.version,0)=?)
      AND (SELECT COUNT(*) FROM api_tokens WHERE user_id=? AND revoked_at IS NULL AND expires_at>? AND identity_version=?)<50`)
      .bind(hash, person.id, label, repositories && JSON.stringify(repositories), permission, branchPattern, version, now, now + lifetimeHours * 3600, person.id, version, person.id, now, version).run();
    if (saved.meta.changes !== 1) throw new Fault('failed_precondition', 412, 'Your account has 50 active API tokens, or its access changed. Revoke unused tokens and retry.');
    const row = await db.prepare('SELECT * FROM api_tokens WHERE digest=?').bind(hash).first();
    return { token: wire(row, person, await repositoryNames(db, env, repositories || []), now), secret, mcpUrl: env.PUBLIC_ORIGIN + '/mcp', origin: env.PUBLIC_ORIGIN };
  }
  if (body.action === 'revoke') {
    if (!fields(body, ['action', 'id']) || typeof body.id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(body.id)) invalid('Choose the API token to revoke.');
    const revoked = await db.prepare('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?').bind(now, Number(body.id), person.id).run();
    if (revoked.meta.changes !== 1) throw new Fault('not_found', 404, 'API token not found.');
    return { id: body.id, revoked: true };
  }
  invalid('Use list, repositories, create or revoke.');
}
