import { Fault, reply, invalid, page, bodyLimit } from './common.mjs';
import { operationsAdmin } from './operations.mjs';

/* The installation audit log: one row per privileged or state-changing request, GitHub style.
 *
 * Recording. core.mjs passes every request through audited() once. A request is recorded only when its route matches a descriptor below;
 * everything a row holds comes from that descriptor's explicit allow-list (names, ids, states, counts, origins), never from a request or
 * response body as a whole. Secret and variable values, signing secrets, credentials, tokens, prompts, notes and file contents are never
 * read into a row. Outcomes: success (2xx), refused (2xx whose receipt reports a refused or failed state), denied (401, 403 and the 404 that
 * hides a repository) and unknown (5xx: a change may have happened). Validation and stale-version refusals are not recorded.
 *
 * Consistency. Installation policy, feature policy and AI model changes already write their row in the same D1 batch as the change
 * (installation.mjs auditStatement); their descriptors say batch: true, so this hook records only their denials. Every other row is
 * written best-effort after the handler returns: a failed audit write never fails or reverses the action, increments the failure counter
 * reported by the read API and logs golf.audit_write_failed. Successful replays of one operation key write one row (operation_id is unique).
 *
 * Extra request facts (outcome, actor kind, IP, user agent, request id, repository name) live in the existing client JSON column, so the
 * append-only table needs no migration. */

let failures = 0, lastFailureAt = '';
export const auditHealth = () => ({ failures, lastFailureAt });

const clip = (value, max = 100) => typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').trim().slice(0, max) : undefined;
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
const flag = value => typeof value === 'boolean' ? value : undefined;
const whole = value => Number.isSafeInteger(value) ? value : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
const names = (value, max = 20) => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, max).map(item => clip(item, 60)) : undefined;
const kind = (value, list, prefix) => typeof value === 'number' ? list[value] : typeof value === 'string' ? value.replace(prefix, '') : undefined;
const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const short = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value.slice(0, 12) : undefined;
function origin(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.origin : undefined; } catch { return undefined; } }

// Small reads made before the change (for before summaries) or after it (names for ids). Each is optional: a failure records less.
const one = (db, sql, ...values) => db.prepare(sql).bind(...values).first();
const poolName = async (db, id) => token(id) ? (await one(db, 'SELECT name FROM native_runner_pools WHERE id=?', id))?.name ?? null : null;
const poolSummary = pool => pool && { name: pool.name, state: pool.state, trustClass: pool.trust_class, maxParallel: pool.max_parallel };
const machine = (db, id) => token(id) ? one(db, 'SELECT m.name,m.state,m.protocol,p.name AS pool FROM native_runner_machines m LEFT JOIN native_runner_pools p ON p.id=m.pool_id WHERE m.id=?', id) : null;
const userLogin = async (db, id) => whole(id) ? (await one(db, 'SELECT login FROM users WHERE id=?', String(id)))?.login : undefined;

const repositoryKey = body => body.repository || body.target?.repository || body.selection?.repository;
const runnerMachine = action => body => ({ action, scope: 'installation', key: () => token(body.id) && `${body.id}:${body.expectedVersion}`,
  before: async c => { const m = await machine(c.db, body.id); return m && { state: m.state }; },
  subject: async c => (await machine(c.db, body.id))?.name || token(body.id),
  after: async c => { const m = await machine(c.db, body.id); return clean({ machine: m?.name, pool: m?.pool, state: action === 'runner.rotate_credential' ? undefined : clip(body.state, 20), lifetimeHours: whole(body.ttlHours), jobId: token(body.jobId) }); } });
const enroll = body => ({ action: 'runner.enroll', scope: 'installation', key: () => token(body.id), subject: () => clip(body.name, 80),
  after: async c => clean({ machine: clip(body.name, 80), pool: await poolName(c.db, body.poolId), protocol: body.action === 'enrollGitLab' ? 'gitlab' : 'native', lifetimeHours: whole(body.ttlHours) }) });
// Admin-only routes record who was turned away; their successful reads are not audited.
const adminDenial = subject => ({ action: 'installation.access_denied', scope: 'installation', deniedOnly: true, subject: () => subject });

const native = {
  'runner-admin': body => ({
    savePool: () => ({ action: body.expectedVersion === 0 ? 'runner_pool.create' : 'runner_pool.update', scope: 'installation', key: () => token(body.id) && `${body.id}:${body.expectedVersion}`,
      subject: () => clip(body.name, 80), before: async c => body.expectedVersion === 0 ? null : poolSummary(token(body.id) && await one(c.db, 'SELECT * FROM native_runner_pools WHERE id=?', body.id)),
      after: () => clean({ name: clip(body.name, 80), state: clip(body.state, 20), trustClass: clip(body.trustClass, 20), maxParallel: whole(body.maxParallel) }) }),
    enroll: () => enroll(body), enrollGitLab: () => enroll(body),
    rotate: () => runnerMachine('runner.rotate_credential')(body),
    control: () => runnerMachine({ DRAINING: 'runner.drain', REVOKED: 'runner.revoke', ACTIVE: 'runner.resume' }[body.state] || 'runner.control')(body),
    reconcile: () => runnerMachine('runner.reconcile')(body),
  }[body.action]?.() || adminDenial('the runner inventory')),
  'runner-placement': body => body.action === 'set' && { action: 'repo.update_runner_placement', scope: 'repository', key: () => `${body.expectedVersion}:${body.poolId}`,
    before: async c => ({ pool: (await one(c.db, 'SELECT n.name FROM native_runner_placements p LEFT JOIN native_runner_pools n ON n.id=p.pool_id WHERE p.repository_id=?', c.repository.id))?.name ?? null }),
    after: async c => ({ pool: await poolName(c.db, body.poolId) }) },
  'repository-visibility': body => body.action === 'set' && { action: 'repo.update_visibility', scope: 'repository', widening: body.isPublic === true,
    before: async c => ({ public: Boolean((await one(c.db, 'SELECT is_public FROM repository_visibility WHERE repository_id=?', c.repository.id))?.is_public) }),
    after: () => ({ public: flag(body.isPublic) }) },
  'repository-grant': body => ({ action: body.role === 'none' ? 'repo.remove_member' : 'repo.update_member', scope: 'repository', subject: c => userLogin(c.db, body.userId),
    before: async c => ({ permission: (await one(c.db, 'SELECT role FROM grants WHERE repository_id=? AND user_id=?', c.repository.id, String(whole(body.userId) ?? '')))?.role ?? null }),
    after: () => ({ permission: body.role === 'none' ? null : clip(body.role, 10) }) }),
  owners: body => body.action === 'createOrganization' ? { action: 'org.create', scope: 'organization', key: () => token(body.idempotencyKey), subject: () => clip(body.slug, 40),
    scopeId: async c => (await one(c.db, "SELECT id FROM native_owners WHERE slug=? AND kind='ORGANIZATION'", clip(body.slug, 40) || ''))?.id,
    after: () => clean({ organization: clip(body.slug, 40), fullName: clip(body.fullName, 100) }) }
    : body.action === 'ensurePersonal' && { action: 'user.claim_owner', scope: 'installation', subject: () => clip(body.login, 40), after: () => clean({ login: clip(body.login, 40) }) },
  'pr-preview': body => ({ create: 'preview.publish', renew: 'preview.renew', revoke: 'preview.revoke', capture: 'preview.capture', screenshot: 'preview.capture' }[body.action]) && {
    action: { create: 'preview.publish', renew: 'preview.renew', revoke: 'preview.revoke', capture: 'preview.capture', screenshot: 'preview.capture' }[body.action], scope: 'repository',
    key: () => token(body.idempotencyKey), subject: () => token(body.previewId) || token(body.jobId), after: () => clean({ jobId: token(body.jobId), previewId: token(body.previewId), kind: clip(body.kind, 20) }) },
  'pr-evidence': body => body.action === 'create' ? { action: 'actions.run_request', scope: 'repository', key: () => token(body.idempotencyKey), subject: () => whole(body.selection?.number) && `#${whole(body.selection.number)}`,
    after: () => clean({ number: whole(body.selection?.number), headCommit: short(body.selection?.headCommitId), tests: flag(body.runTests), advice: flag(body.advice), agent: body.agent ? true : undefined }) }
    : body.action === 'cancel' && { action: 'actions.run_cancel', scope: 'repository', subject: () => token(body.jobId), after: () => clean({ jobId: token(body.jobId) }) },
  // Self-hosted pipeline runners (stock Forgejo and GitLab runners): registration tokens, edits and deletes. The token itself is never read.
  'pipeline-runners': body => pipelineRunnerActions[body.action] && ({ action: pipelineRunnerActions[body.action], scope: ['organization', 'repository'].includes(body.scope) ? body.scope : 'installation',
    scopeId: async c => (await one(c.db, "SELECT id FROM native_owners WHERE slug=? AND kind='ORGANIZATION'", clip(body.organization, 40) || ''))?.id,
    subject: async c => body.action === 'createToken' ? clip(body.engine, 20) : (whole(body.id) && (await one(c.db, 'SELECT name FROM pipeline_runners WHERE id=?', whole(body.id)))?.name) || token(body.id),
    before: async c => { const r = ['update', 'delete'].includes(body.action) && whole(body.id) && await one(c.db, 'SELECT name,state,labels FROM pipeline_runners WHERE id=?', whole(body.id));
      return r ? clean({ name: clip(r.name, 128), state: r.state, labels: names(JSON.parse(r.labels || '[]'), 32) }) : undefined; },
    after: () => body.action === 'delete' ? null : clean({ engine: clip(body.engine, 20), labels: names(body.labels, 32), ttlHours: whole(body.ttlHours), uses: whole(body.uses), state: clip(body.state, 12) }) }),
  // Actions tab changes on one repository. Approval comments, dispatch input values and environment values are never read.
  pipelines: body => {
    const action = { dispatch: 'actions.dispatch', cancel: 'actions.cancel', rerun: 'actions.rerun', play: 'actions.play_job', approve: body.approve === true ? 'actions.approve_deployment' : 'actions.reject_deployment',
      saveEnvironment: 'environment.save', saveEnvironmentValue: 'environment.save_value' }[body.action];
    return action && { action, scope: 'repository', subject: () => body.action === 'dispatch' ? clip(body.workflowPath, 200) : ['saveEnvironment', 'saveEnvironmentValue'].includes(body.action) ? clip(body.name, 100) : token(body.runId) || token(body.jobId),
      after: () => clean({ ref: clip(body.ref, 100), inputs: body.action === 'dispatch' && body.inputs && typeof body.inputs === 'object' ? Object.keys(body.inputs).length : undefined,
        failedOnly: body.action === 'rerun' ? flag(body.failedOnly) : undefined, kind: body.action === 'saveEnvironmentValue' ? clip(body.kind, 12) : undefined,
        reviewers: Array.isArray(body.reviewers) ? body.reviewers.length : undefined, branches: Array.isArray(body.branches) ? body.branches.length : undefined, preventSelfReview: flag(body.preventSelfReview) }) };
  },
  // Agent hosts (docs/AGENT_HOSTS.md). Personal and installation hosts are recorded at installation scope, organization hosts at their
  // organization; the scope of an update, delete or revocation comes from the stored host or token. Never the token, credential or a prompt.
  'agent-hosts': body => agentHostActions[body.action] && ({ action: agentHostActions[body.action],
    scope: async c => { c.agentScope = await agentHostScope(c.db, body); return c.agentScope?.scope === 'organization' ? 'organization' : 'installation'; },
    scopeId: c => c.agentScope?.scopeId,
    subject: c => body.action === 'createToken' ? clip(body.scope, 20) : body.action === 'revokeToken' ? token(body.id) : c.agentScope?.name || token(body.id),
    before: async c => { const h = ['update', 'delete'].includes(body.action) && whole(body.id) && await one(c.db, 'SELECT * FROM agent_hosts WHERE id=?', whole(body.id)); return h ? agentHostSummary(h) : undefined; },
    after: () => body.action === 'delete' ? null : body.action === 'revokeToken' ? clean({ id: token(body.id) }) : body.action === 'createToken' ? clean({ scope: clip(body.scope, 20), organization: clip(body.organization, 40), ttlHours: whole(body.ttlHours), uses: whole(body.uses) })
      : clean({ name: clip(body.name, 128), state: clip(body.state, 12), shareSignins: flag(body.shareSignins), allowedUsers: names(body.allowedUsers, 50), allowedRepositories: names(body.allowedRepositories, 100), enabledTools: names(body.enabledTools, 4), maxConcurrent: whole(body.maxConcurrent) }) }),
  // Assign to agent and cancel. The instructions and the prompt are never read.
  'agent-tasks': body => body.action === 'create' ? { action: 'agent_task.create', scope: 'repository', key: () => token(body.idempotencyKey), subject: () => whole(body.target?.number) && `#${whole(body.target.number)}`,
    after: () => clean({ kind: clip(body.target?.kind, 20), number: whole(body.target?.number), hostId: whole(body.hostId), tool: clip(body.tool, 20), model: clip(body.model, 100) }) }
    : body.action === 'cancel' && { action: 'agent_task.cancel', scope: 'repository', subject: () => token(body.id), after: () => clean({ taskId: token(body.id) }) },
  // Personal API tokens (docs/AGENT_ACCESS.md), at installation scope like personal agent hosts. Never the secret; denied uses are
  // written by api-tokens.mjs at repository scope.
  'api-tokens': body => body.action === 'create' ? { action: 'api_token.create', scope: 'installation', subject: () => clip(body.label, 64),
    after: () => clean({ label: clip(body.label, 64), permission: clip(body.permission, 10), repositories: Array.isArray(body.repositories) ? body.repositories.length : body.repositories === null || body.repositories === undefined ? 'all' : undefined,
      branchPattern: clip(body.branchPattern, 200) || undefined, lifetimeHours: whole(body.lifetimeHours) }) }
    : body.action === 'revoke' && { action: 'api_token.revoke', scope: 'installation', subject: async c => (token(body.id) && (await one(c.db, 'SELECT label FROM api_tokens WHERE id=?', whole(body.id) ?? 0))?.label) || token(body.id),
      after: () => clean({ id: token(body.id) }) },
  // Agentic mode settings (docs/AGENTIC_MODE.md): the stored setting before, the saved values after. Reads and evaluations are not recorded.
  'agentic-mode': body => body.action === 'set' && { action: 'agentic_mode.update', scope: 'repository', key: () => token(body.repositoryId) && whole(body.expectedVersion) !== undefined && `${body.repositoryId}:${whole(body.expectedVersion)}`,
    before: async c => { const s = await one(c.db, 'SELECT * FROM repository_agentic_settings WHERE repository_id=?', c.repository.id); return s ? agenticSummary({ enabled: Boolean(s.enabled), landWithoutPerson: Boolean(s.land_without_person),
      revertOnFailure: Boolean(s.revert_on_failure), lowRiskPaths: JSON.parse(s.low_risk_paths), sensitivePaths: JSON.parse(s.sensitive_paths), requiredChecks: JSON.parse(s.required_checks) }) : null; },
    after: () => agenticSummary(body) },
  // Landing a pull request (docs/AGENTIC_MODE.md). Lands and reverts by the policy itself are written by land-queue.mjs (actor 0).
  land: body => body.action === 'land' && { action: 'agentic_mode.land', scope: 'repository', key: () => token(body.idempotencyKey), subject: () => whole(body.number) && `#${whole(body.number)}`,
    after: () => clean({ number: whole(body.number), method: clip(body.method, 10) || 'merge' }) },
  // Automations (docs/AUTOMATIONS.md) at the scope the request names; the stored automation must match it. Never the instructions text.
  automations: body => automationActions(body) && ({ action: automationActions(body), scope: ['repository', 'organization'].includes(body.scope) ? body.scope : 'installation',
    scopeId: async c => (await one(c.db, "SELECT id FROM native_owners WHERE slug=? AND kind='ORGANIZATION'", clip(body.organization, 40) || ''))?.id,
    key: () => body.action === 'update' || body.action === 'setEnabled' ? token(body.id) && whole(body.expectedVersion) !== undefined && `${body.id}:${whole(body.expectedVersion)}` : undefined,
    subject: async c => body.action === 'create' ? clip(body.name, 100) || clip(body.tool, 20) : (token(body.id) && (await one(c.db, 'SELECT name FROM automations WHERE id=?', body.id))?.name) || token(body.id),
    before: async c => { const a = ['update', 'setEnabled', 'killSwitch', 'delete'].includes(body.action) && token(body.id) && await one(c.db, 'SELECT * FROM automations WHERE id=?', body.id); return a ? automationSummary(a) : undefined; },
    after: () => body.action === 'delete' ? null : body.action === 'run' ? clean({ kind: clip(body.target?.kind, 20), number: whole(body.target?.number), runId: whole(body.target?.runId), repository: body.target?.repository ? clip(`${body.target.repository.owner}/${body.target.repository.name}`, 200) : undefined })
      : body.action === 'setEnabled' ? clean({ enabled: flag(body.enabled) }) : body.action === 'killSwitch' ? clean({ killSwitch: flag(body.engaged) })
      : clean({ tool: clip(body.tool, 20), name: clip(body.name, 100), events: names(body.trigger?.events, 10), everyMinutes: whole(body.trigger?.schedule?.everyMinutes), engine: clip(body.engine, 100), place: clip(body.place, 20),
        hostId: whole(body.hostId), outputs: names(body.output, 6), repositories: Array.isArray(body.target?.repositories) ? body.target.repositories.length : undefined, instructionsChanged: typeof body.instructions === 'string' ? true : undefined,
        perDay: whole(body.limits?.perDay), concurrency: whole(body.limits?.concurrency), maxOpenPRs: whole(body.limits?.maxOpenPRs), allowLanding: flag(body.approvals?.allowLanding) }) }),
  ai: body => body.action === 'create' && { action: 'ai.run_request', scope: 'repository', key: () => token(body.idempotencyKey), subject: () => clip(body.kind, 40),
    after: () => clean({ kind: clip(body.kind, 40), number: whole(body.target?.number), tag: clip(body.target?.tagName, 100) }) },
  // The agentic inbox asks for an intent summary through the same AI runs (docs/AGENTIC_MODE.md); inbox reads are not recorded.
  'agent-inbox': body => body.action === 'summarize' && { action: 'ai.run_request', scope: 'repository', key: () => token(body.idempotencyKey), subject: () => 'intent-summary',
    after: () => clean({ kind: 'intent-summary', number: whole(body.number) }) },
  installation: body => ({ action: 'installation_policy.update', scope: 'installation', batch: true, subject: () => clip(body.key, 40) }),
  'installation/read': () => adminDenial('the installation settings'),
  'ai-models': body => ({ action: body.repository ? 'repository_ai_model.update' : 'ai_model.update', scope: body.repository ? 'repository' : 'installation', batch: true, subject: () => clip(body.use, 40) && 'ai.model.' + clip(body.use, 40) }),
  'audit/read': body => body.scope === 'installation' && adminDenial('the installation audit log'),
  // Credential vault and engines (docs/CREDENTIAL_VAULT.md, docs/ENGINES.md): each change writes its own row in the same batch (vault.mjs,
  // engines.mjs), so these record refusals only; a use refused by a grant is written by vault.mjs as credential.use_denied. Never a value.
  credentials: body => ['create', 'rotate', 'revoke', 'grant', 'ungrant'].includes(body.action) && { action: 'credential.' + body.action, batch: true,
    scope: async c => { c.vault = token(body.id) ? await one(c.db, 'SELECT scope,owner_id,label FROM vault_credentials WHERE id=?', body.id) : null; return (c.vault?.scope || body.scope) === 'organization' ? 'organization' : 'installation'; },
    scopeId: async c => c.vault ? c.vault.owner_id : (await one(c.db, "SELECT id FROM native_owners WHERE slug=? AND kind='ORGANIZATION'", clip(body.organization, 40) || ''))?.id,
    subject: c => c.vault?.label || clip(body.label, 64) || token(body.id) },
  engines: body => ['create', 'update', 'delete', 'select'].includes(body.action) && { action: body.action === 'select' ? 'engine_selection.update' : 'engine.' + body.action, batch: true,
    scope: async c => { c.engine = token(body.id) ? await one(c.db, 'SELECT scope,owner_id,name FROM engines WHERE id=?', body.id) : null; const scope = c.engine?.scope || body.scope; return scope === 'organization' ? 'organization' : scope === 'repository' ? 'repository' : 'installation'; },
    scopeId: async c => c.engine ? c.engine.owner_id : (await one(c.db, "SELECT id FROM native_owners WHERE slug=? AND kind='ORGANIZATION'", clip(body.organization, 40) || ''))?.id,
    subject: c => body.action === 'select' ? 'engine:' + (clip(body.use, 40) || '') : c.engine?.name || clip(body.name, 80) || token(body.id) },
};

const automationActions = body => ({ create: 'automation.create', update: 'automation.update', delete: 'automation.delete', run: 'automation.run',
  setEnabled: body.enabled === true ? 'automation.enable' : body.enabled === false ? 'automation.disable' : undefined, killSwitch: body.engaged === true ? 'automation.kill_switch' : body.engaged === false ? 'automation.release_kill_switch' : undefined })[body.action];
const automationSummary = a => { const parse = text => { try { return JSON.parse(text); } catch { return {}; } };
  return clean({ tool: a.tool, name: clip(a.name, 100), enabled: Boolean(a.enabled), killSwitch: Boolean(a.kill_switch), engine: clip(a.engine, 100), place: a.place, events: names(parse(a.trigger).events, 10), outputs: names(parse(a.output).kinds, 6), instructionsVersion: a.instructions_version }); };
const agentHostActions = { createToken: 'agent_host.token_create', revokeToken: 'agent_host.token_revoke', update: 'agent_host.update', delete: 'agent_host.delete' };
async function agentHostScope(db, body) {
  if (body.action === 'createToken') return { scope: clip(body.scope, 20), scopeId: body.scope === 'organization' ? (await one(db, "SELECT id FROM native_owners WHERE slug=? AND kind='ORGANIZATION'", clip(body.organization, 40) || ''))?.id : undefined };
  const row = body.action === 'revokeToken' ? token(body.id) && await one(db, 'SELECT scope,scope_id FROM agent_host_registrations WHERE id=?', body.id) : whole(body.id) && await one(db, 'SELECT name,scope,scope_id FROM agent_hosts WHERE id=?', whole(body.id));
  return row ? { scope: row.scope, scopeId: row.scope_id, name: row.name } : null;
}
const agentHostSummary = h => clean({ name: clip(h.name, 128), state: h.state, shareSignins: Boolean(h.share_signins), allowedUsers: JSON.parse(h.allowed_users || '[]').length, allowedRepositories: JSON.parse(h.allowed_repositories || '[]').length,
  enabledTools: names(JSON.parse(h.enabled_tools || '[]'), 4), maxConcurrent: h.max_concurrent });
const agenticSummary = value => clean({ enabled: flag(value.enabled), landWithoutPerson: flag(value.landWithoutPerson), revertOnFailure: flag(value.revertOnFailure),
  lowRiskPaths: names(value.lowRiskPaths, 50), sensitivePaths: names(value.sensitivePaths, 50), requiredChecks: names(value.requiredChecks, 50) });
const pipelineRunnerActions = { createToken: 'pipeline_runner.token_create', revokeToken: 'pipeline_runner.token_revoke', update: 'pipeline_runner.update', delete: 'pipeline_runner.delete' };
const valueKinds = ['', 'secret', 'variable'], ruleActions = ['', 'CREATE_BRANCH', 'EDIT_BRANCH', 'REMOVE_BRANCH', 'CREATE_TAG', 'EDIT_TAG', 'REMOVE_TAG', 'EDIT_MERGE'];
const resourceKinds = ['UNSPECIFIED', 'CREATE_LABEL', 'UPDATE_LABEL', 'DELETE_LABEL', 'CREATE_MILESTONE', 'UPDATE_MILESTONE', 'DELETE_MILESTONE'], releaseKinds = ['', 'EDIT', 'DELETE', 'UPLOAD_ASSET', 'RENAME_ASSET', 'DELETE_ASSET'];
const repo = (action, more = {}) => ({ action, scope: 'repository', ...more });
const executionValue = body => {
  const valueKind = kind(body.kind, valueKinds, 'REPOSITORY_EXECUTION_VALUE_KIND_')?.toLowerCase();
  return repo(`repository_${valueKind === 'variable' ? 'variable' : 'secret'}.${body.expectedVersion === '0' || body.expectedVersion === 0 ? 'create' : 'update'}`, { key: () => token(body.operationId),
    subject: () => clip(body.name, 100), after: () => clean({ name: clip(body.name, 100), kind: valueKind }) });
};
const rpc = {
  'RepositoryService/CreateRepository': body => repo('repo.create', { key: () => token(body.idempotencyKey), repository: c => c.db.prepare('SELECT id FROM repositories WHERE name=?').bind(clip(body.name, 100) || '').first(),
    subject: () => clip(body.name, 100), after: () => clean({ name: clip(body.name, 100), owner: clip(body.owner, 40), private: flag(body.private) }) }),
  'RepositorySettingsService/UpdateRepositorySettings': body => repo('repo.update_settings', {
    before: async c => { const s = await one(c.db, 'SELECT s.description,s.website,r.default_branch FROM repositories r LEFT JOIN repository_settings s ON s.repository_id=r.id WHERE r.id=?', c.repository.id);
      return s && clean({ description: 'description' in body ? clip(s.description ?? '', 200) : undefined, website: 'website' in body ? clip(s.website ?? '', 200) : undefined, defaultBranch: 'defaultBranch' in body ? s.default_branch : undefined }); },
    after: () => clean({ description: clip(body.description, 200), website: clip(body.website, 200), defaultBranch: clip(body.defaultBranch, 200) }) }),
  'RepositorySettingsService/UpdateRepositoryTopics': body => repo('repo.update_topics', { after: () => ({ topics: names(body.topics, 25) || [] }) }),
  'RepositoryAccessService/SetRepositoryCollaborator': body => repo(c => c.before?.permission ? 'repo.update_member' : 'repo.add_member', { key: () => token(body.idempotencyKey), subject: () => clip(body.userLogin, 60),
    before: async c => ({ permission: (await one(c.db, 'SELECT role FROM grants WHERE repository_id=? AND user_id=?', c.repository.id, String(whole(body.userId) ?? '')))?.role ?? null }),
    after: () => ({ permission: clip(body.permission, 10) }) }),
  'RepositoryAccessService/RemoveRepositoryCollaborator': body => repo('repo.remove_member', { key: () => token(body.idempotencyKey), subject: () => clip(body.userLogin, 60),
    before: async c => ({ permission: (await one(c.db, 'SELECT role FROM grants WHERE repository_id=? AND user_id=?', c.repository.id, String(whole(body.userId) ?? '')))?.role ?? null }), after: () => ({ permission: null }) }),
  'RepositoryInvitationService/CreateRepositoryInvitation': body => repo('repository_invitation.create', { key: () => token(body.idempotencyKey), subject: () => clip(body.recipientUsername || body.username, 60),
    after: () => clean({ recipient: clip(body.recipientUsername || body.username, 60), permission: clip(body.permission, 10), expiresAt: clip(body.expiresAt, 40) }) }),
  'RepositoryInvitationService/RevokeRepositoryInvitation': body => repo('repository_invitation.revoke', { key: () => token(body.idempotencyKey), subject: c => invitationRecipient(c.db, body.invitationId), after: () => clean({ invitationId: token(body.invitationId) }) }),
  'RepositoryInvitationService/RespondRepositoryInvitation': body => repo([1, 'REPOSITORY_INVITATION_DECISION_ACCEPT'].includes(body.decision) ? 'repository_invitation.accept' : 'repository_invitation.decline', { key: () => token(body.idempotencyKey),
    repository: c => token(body.invitationId) ? one(c.db, 'SELECT repository_id AS id FROM repository_invitations WHERE id=?', body.invitationId) : null, subject: c => invitationRecipient(c.db, body.invitationId), after: () => clean({ invitationId: token(body.invitationId) }) }),
  'RepositoryRulesService/MutateRepositoryRules': body => {
    const action = typeof body.action === 'string' ? ruleActions.indexOf(body.action.replace(/^REPOSITORY_RULE_MUTATION_ACTION_/, '')) : body.action;
    const name = { 1: 'protected_branch.create', 2: 'protected_branch.update', 3: 'protected_branch.destroy', 4: 'protected_tag.create', 5: 'protected_tag.update', 6: 'protected_tag.destroy', 7: 'repo.update_merge_settings' }[action];
    return name && repo(name, { key: () => token(body.operationId), subject: () => clip(body.ruleName || body.desiredTag?.namePattern, 100) || token(body.tagId),
      after: () => action === 3 || action === 6 ? null : clean({ pattern: clip(body.desiredBranch?.ruleName || body.desiredTag?.namePattern, 100), allowedUsers: names(body.desiredTag?.allowedUsernames) }) });
  },
  'RepositoryWebhookService/SaveRepositoryWebhook': body => repo(c => c.before ? 'hook.update' : 'hook.create', { key: () => token(body.operationId), subject: () => clip(body.name, 120),
    before: async c => { const s = token(body.id) && await one(c.db, 'SELECT name,enabled FROM webhook_subscriptions WHERE id=? AND repository_id=?', body.id, c.repository.id); return s ? { name: s.name, enabled: Boolean(s.enabled) } : null; },
    // The endpoint's origin only: paths and queries often carry a receiver's token. The signing secret is reported as replaced or not.
    after: () => clean({ name: clip(body.name, 120), endpointOrigin: origin(body.endpoint), enabled: flag(body.enabled), events: names(body.eventTopics), signingSecretReplaced: body.signingSecret ? true : undefined }) }),
  'RepositoryWebhookService/TestRepositoryWebhook': body => repo('hook.test', { subject: () => token(body.subscriptionId || body.id) }),
  'RepositoryWebhookService/RedeliverRepositoryWebhook': body => repo('hook.redeliver', { key: () => token(body.operationId), subject: () => token(body.deliveryId), after: () => clean({ deliveryId: token(body.deliveryId) }) }),
  'RepositoryExecutionValueService/SaveRepositoryExecutionValue': executionValue,
  'RepositoryExecutionValueService/DeleteRepositoryExecutionValue': body => repo(c => `repository_${c.before?.kind === 'variable' ? 'variable' : 'secret'}.destroy`, { key: () => token(body.operationId),
    before: async c => { const v = token(body.id) && await one(c.db, 'SELECT name,kind FROM execution_values WHERE id=? AND repository_id=?', body.id, c.repository.id); return v ? { name: v.name, kind: v.kind } : null; },
    subject: c => c.before?.name || token(body.id), after: () => null }),
  'RepositoryExecutionValueService/SaveRepositoryExecutionBinding': body => repo('repository_secret.approve_workflow', { key: () => token(body.operationId), subject: () => clip(body.workflowPath, 200),
    after: () => clean({ workflowPath: clip(body.workflowPath, 200), commit: short(body.commitId), event: clip(body.event, 40) }) }),
  'RepositoryExecutionValueService/DeleteRepositoryExecutionBinding': body => repo('repository_secret.revoke_workflow', { key: () => token(body.operationId), subject: () => clip(body.workflowPath, 200) || token(body.id) }),
  'RepositoryEnvironmentService/SaveRepositoryEnvironment': body => repo(body.expectedVersion === '0' || body.expectedVersion === 0 ? 'environment.create' : 'environment.update', { key: () => token(body.operationId), subject: () => clip(body.name, 60),
    after: () => clean({ name: clip(body.name, 60), allowAllSources: flag(body.policy?.allowAllSources), sources: Array.isArray(body.policy?.sources) ? body.policy.sources.length : undefined,
      lifetimeSeconds: whole(body.policy?.lifetimeSeconds), concurrency: whole(body.policy?.concurrency) }) }),
  'RepositoryEnvironmentService/DeleteRepositoryEnvironment': body => repo('environment.delete', { key: () => token(body.operationId), subject: () => token(body.environmentId) }),
  'GitTransportService/CreateGitCredential': body => repo('git_credential.create', { subject: () => clip(body.label, 100),
    after: () => clean({ label: clip(body.label, 100), access: body.mode === 2 || body.mode === 'GIT_CREDENTIAL_MODE_WRITE' ? 'write' : 'read', lifetimeSeconds: whole(body.lifetimeSeconds) }) }),
  'GitTransportService/RevokeGitCredential': body => repo('git_credential.revoke', { subject: async c => whole(body.credentialId) && (await one(c.db, 'SELECT label FROM git_credentials WHERE id=?', String(whole(body.credentialId))))?.label || token(body.credentialId),
    after: () => clean({ credentialId: token(body.credentialId) }) }),
  'RepositoryReleasePublicationService/SubmitRepositoryReleasePublication': body => repo('release.publish', { key: () => token(body.operationId), subject: () => clip(body.tagName, 100),
    after: () => clean({ tag: clip(body.tagName, 100), title: clip(body.title, 120), draft: flag(body.draft), prerelease: flag(body.prerelease) }) }),
  'RepositoryReleaseManagementService/SubmitRepositoryReleaseOperation': body => {
    const action = { EDIT: 'release.update', DELETE: 'release.destroy', UPLOAD_ASSET: 'release_asset.upload', RENAME_ASSET: 'release_asset.rename', DELETE_ASSET: 'release_asset.destroy' }[kind(body.kind, releaseKinds, 'REPOSITORY_RELEASE_OPERATION_KIND_')];
    return action && repo(action, { key: () => token(body.operationId), subject: async c => whole(body.releaseId) && (await one(c.db, 'SELECT tag_name FROM repository_releases WHERE id=? AND repository_id=?', String(whole(body.releaseId)), c.repository.id))?.tag_name || token(body.releaseId),
      after: () => clean({ title: clip(body.title, 120), draft: flag(body.draft), prerelease: flag(body.prerelease), asset: clip(body.assetName, 120), assetId: token(body.assetId) }) });
  },
  'StandardPullMergeService/SubmitStandardPullMerge': body => repo('pull_request.merge', { key: () => token(body.operationId), subject: () => whole(body.number ?? body.selection?.number) && `#${whole(body.number ?? body.selection?.number)}`,
    after: () => clean({ number: whole(body.number ?? body.selection?.number), method: clip(body.method, 20), target: clip(body.targetRef, 200), source: clip(body.sourceRef, 200) }) }),
  'PullReviewRequestService/SubmitPullReviewLifecycle': body => repo(body.dismiss === false ? 'pull_request_review.restore' : 'pull_request_review.dismiss', { key: () => token(body.operationId), subject: () => whole(body.number) && `#${whole(body.number)}`,
    after: () => clean({ number: whole(body.number), reviewId: token(body.reviewId) }) }),
  'RepositoryService/SubmitDiscussionResourceOperation': body => {
    const k = kind(body.kind, resourceKinds, 'DISCUSSION_RESOURCE_OPERATION_KIND_'), action = { CREATE_LABEL: 'label.create', UPDATE_LABEL: 'label.update', DELETE_LABEL: 'label.destroy', CREATE_MILESTONE: 'milestone.create', UPDATE_MILESTONE: 'milestone.update', DELETE_MILESTONE: 'milestone.destroy' }[k];
    return action && repo(action, { key: () => token(body.idempotencyKey || body.operationId), subject: () => clip(body.label?.name || body.milestone?.title, 100) || token(body.resourceId),
      after: () => action.endsWith('.destroy') ? null : clean({ name: clip(body.label?.name || body.milestone?.title, 100), color: token(body.label?.color) }) });
  },
  'ExecutionPolicyService/UpdateExecutionPolicy': body => body.repository && repo('repo.update_actions_settings', {
    after: () => clean({ mode: clip(body.mode, 40)?.replace('EXECUTION_MODE_', '').toLowerCase(), allowAllWorkflows: flag(body.allowAllWorkflows), workflows: Array.isArray(body.workflowPaths) ? body.workflowPaths.length : undefined }) }),
  'RepositoryFeatureService/UpdateRepositoryFeatures': () => repo('repository_feature.update', { batch: true }),
  'FeaturePolicyService/UpdateFeaturePolicy': body => ({ action: 'feature_policy.update', scope: 'installation', batch: true, subject: () => clip(body.feature, 40) && 'feature:' + clip(body.feature, 40) }),
};
const invitationRecipient = async (db, id) => token(id) && (await one(db, 'SELECT u.login FROM repository_invitations i JOIN users u ON u.id=i.recipient_id WHERE i.id=?', id).catch(() => null))?.login || token(id);

function routeOf(path) {
  const nativeRoute = /^\/native\/([a-z/-]+)$/.exec(path)?.[1], rpcRoute = /^\/rpc\/golf\.v1\.([A-Za-z]+\/[A-Za-z]+)$/.exec(path)?.[1];
  return nativeRoute && Object.hasOwn(native, nativeRoute) ? native[nativeRoute] : rpcRoute && Object.hasOwn(rpc, rpcRoute) ? rpc[rpcRoute] : null;
}
export const auditedRoute = path => Boolean(routeOf(path));
const descriptorFor = (path, body) => routeOf(path)?.(body) || null;

async function resolveRepository(db, env, key) {
  if (!key || typeof key.name !== 'string' || typeof key.owner !== 'string') return null;
  const row = await one(db, 'SELECT r.id,r.name,o.slug AS owner_slug,o.kind AS owner_kind FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.name=?', key.name);
  return row && (row.owner_slug || env.WORKSPACE_SLUG) === key.owner ? repositoryView(row, env) : null;
}
const repositoryView = (row, env) => ({ id: String(row.id), fullName: `${row.owner_slug || env.WORKSPACE_SLUG}/${row.name}`, organization: row.owner_kind === 'ORGANIZATION' ? row.owner_slug : '' });
async function repositoryById(db, env, id) {
  const row = id && await one(db, 'SELECT r.id,r.name,o.slug AS owner_slug,o.kind AS owner_kind FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.id=?', String(id));
  return row ? repositoryView(row, env) : null;
}

// Who and from where. Every value is bounded and validated; none of them is a credential.
function caller(request, person) {
  const header = name => request.headers.get(name) || '', authorization = header('Authorization');
  const via = header('CF-Access-Client-Id') ? 'service' : authorization.startsWith('Bearer golf_native_') ? 'token' : authorization.startsWith('Bearer golf_pat_') ? 'api_token' : authorization.startsWith('Bearer golf_agent_task_') ? 'agent_task' : authorization.startsWith('Basic ') || authorization.startsWith('Bearer golf_git_') ? 'git'
    : header('X-Golf-Native-Access-Email') ? 'person' : 'anonymous';
  const country = [header('X-Golf-Native-Access-Country'), header('CF-IPCountry')].find(value => /^[A-Z]{2}$/.test(value));
  const ray = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/.test(header('CF-Ray')) ? header('CF-Ray') : '';
  return { actorId: person?.id || 0, login: person?.login || '', email: /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(header('X-Golf-Native-Access-Email')) ? header('X-Golf-Native-Access-Email') : '',
    client: clean({ via, serviceToken: via === 'service' ? clip(header('CF-Access-Client-Id'), 80) : undefined, colo: /^[A-Z]{3}$/.test(header('X-Golf-Native-Access-Colo')) ? header('X-Golf-Native-Access-Colo') : undefined,
      country, ip: /^[0-9A-Fa-f.:]{2,45}$/.test(header('CF-Connecting-IP')) ? header('CF-Connecting-IP') : undefined, userAgent: clip(header('User-Agent'), 200) || undefined, requestId: ray || crypto.randomUUID() }) };
}

// Only a code and receipt states are read from the response; nothing else in it reaches the row.
async function outcomeOf(response) {
  if (response.status >= 500) return { outcome: 'unknown', code: 'unavailable' };
  let value = null;
  try { if ((response.headers.get('Content-Type') || '').startsWith('application/json')) value = await response.clone().json(); } catch { /* not JSON */ }
  const code = typeof value?.code === 'string' && /^[a-z_]{1,40}$/.test(value.code) ? value.code : '';
  if (response.status === 401 || response.status === 403 || response.status === 404 && ['not_found', 'permission_denied'].includes(code)) return { outcome: 'denied', code: code || 'permission_denied' };
  if (!response.ok) return null;
  const states = value && typeof value === 'object' ? [value, ...Object.values(value).filter(item => item && typeof item === 'object' && !Array.isArray(item))].flatMap(item => [item.state, item.phase]).filter(state => typeof state === 'string') : [];
  const refused = states.find(state => /(?:^|_)(?:REFUSED|REJECTED|DENIED|FAILED)$/.test(state));
  return refused ? { outcome: 'refused', code: refused.toLowerCase().slice(0, 40) } : { outcome: 'success', code: '' };
}

// A bounded copy of the JSON body. Cancelling one branch of a tee settles only when both are cancelled, so an oversized copy is abandoned, not awaited.
async function copy(request, limit) {
  const reader = request.clone().body?.getReader(), chunks = [];
  if (!reader) return '';
  for (let size = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { reader.cancel().catch(() => {}); throw Error('payload limit'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/* The single recording point, called by core.mjs around the request dispatch. identify() resolves the signed-in actor from headers only
 * (null when there is none). The response is returned unchanged whether or not the row is written. */
export async function audited(request, env, run, identify) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !auditedRoute(path)) return run();
  let body = null;
  try { body = JSON.parse(await copy(request, bodyLimit(path))); } catch { /* the handler reports the invalid request */ }
  const descriptor = body && typeof body === 'object' && !Array.isArray(body) ? descriptorFor(path, body) : null;
  if (!descriptor) return run();
  const db = env.DB.withSession('first-primary'), context = { db, env, body, repository: null, before: undefined };
  try {
    // A descriptor may name its scope from stored rows (agent hosts); one it cannot resolve is recorded at installation scope.
    if (typeof descriptor.scope === 'function') descriptor.scope = await descriptor.scope(context);
    if (descriptor.scope === 'repository') context.repository = await resolveRepository(db, env, repositoryKey(body)) || (descriptor.repository && await repositoryById(db, env, (await descriptor.repository(context))?.id));
    if (descriptor.before && (descriptor.scope !== 'repository' || context.repository)) context.before = await descriptor.before(context);
  } catch { if (typeof descriptor.scope === 'function') descriptor.scope = 'installation'; /* a missing before summary is recorded as unknown */ }
  const response = await run();
  let action = '';
  try {
    const result = await outcomeOf(response);
    if (!result || result.outcome === 'success' && (descriptor.batch || descriptor.deniedOnly) || descriptor.deniedOnly && result.outcome !== 'denied') return response;
    if (descriptor.scope === 'repository' && !context.repository && descriptor.repository) context.repository = await repositoryById(db, env, (await descriptor.repository(context))?.id);
    action = typeof descriptor.action === 'function' ? descriptor.action(context) : descriptor.action;
    let person = null;
    try { person = await identify(); } catch { /* recorded as the anonymous or unknown caller */ }
    const who = caller(request, person), repository = context.repository;
    // A repository action whose repository cannot be named is recorded at installation scope, where only operations administrators read it.
    const scope = descriptor.scope === 'repository' && !repository ? 'installation' : descriptor.scope;
    const scopeId = scope === 'repository' ? repository.id : scope === 'organization' ? String(await descriptor.scopeId?.(context) ?? '') : env.WORKSPACE_SLUG || '';
    const subject = String((await descriptor.subject?.(context)) ?? repository?.fullName ?? '').slice(0, 200) || action;
    const after = result.outcome === 'success' && descriptor.after ? await descriptor.after(context) : undefined;
    const key = result.outcome === 'success' && descriptor.key?.();
    await db.prepare('INSERT OR IGNORE INTO installation_audit(at,actor_id,actor_email,scope,scope_id,subject,action,before,after,widening,operation_id,client) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(new Date().toISOString(), who.actorId, who.email, scope, scopeId, subject, action, context.before === undefined ? null : JSON.stringify(context.before), after === undefined ? null : JSON.stringify(after),
        descriptor.widening && result.outcome === 'success' ? 1 : 0, key ? `audit:${action}:${who.actorId}:${key}` : null,
        JSON.stringify(clean({ ...who.client, login: who.login || undefined, outcome: result.outcome, code: result.code || undefined, repository: repository?.fullName || (descriptor.scope === 'repository' ? clip(`${repositoryKey(body)?.owner}/${repositoryKey(body)?.name}`, 200) : undefined), organization: repository?.organization || undefined, route: path.slice(0, 120) }))).run();
  } catch (error) {
    failures++; lastFailureAt = new Date().toISOString();
    console.log(JSON.stringify({ event: 'golf.audit_write_failed', action, route: path, error: String(error?.message || error).slice(0, 200) }));
  }
  return response;
}

/* Reading. Categories are the action prefix; the first installation policy rows used the bare action 'update'. */
const categories = [['installation_policy', 'Installation policy', ['update', 'installation_policy.']], ['feature_policy', 'Feature policy'], ['ai_model', 'AI models', ['ai_model.', 'repository_ai_model.']],
  ['installation', 'Admin access'], ['runner_pool', 'Runner pools'], ['runner', 'Runners'], ['pipeline_runner', 'Pipeline runners'], ['agent_host', 'Coding agents', ['agent_host.', 'agent_task.']], ['api_token', 'API tokens'], ['credential', 'Credentials'], ['engine', 'Engines', ['engine.', 'engine_selection.']], ['agentic_mode', 'Agentic mode'], ['automation', 'Automations'], ['org', 'Organizations'], ['user', 'Accounts'], ['repo', 'Repositories', ['repo.', 'repository_feature.']],
  ['repository_invitation', 'Invitations'], ['protected_branch', 'Rules', ['protected_branch.', 'protected_tag.']], ['hook', 'Webhooks'], ['repository_secret', 'Secrets and variables', ['repository_secret.', 'repository_variable.']],
  ['environment', 'Environments'], ['git_credential', 'Git credentials'], ['git_write', 'Git writes'], ['preview', 'Previews'], ['release', 'Releases', ['release.', 'release_asset.']], ['pull_request', 'Pull requests', ['pull_request.', 'pull_request_review.']],
  ['label', 'Labels and milestones', ['label.', 'milestone.']], ['ai', 'AI runs', ['ai.']], ['actions', 'Actions runs']].map(([id, label, prefixes]) => ({ id, label, prefixes: prefixes || [id + '.'] }));
const categoryOf = action => categories.find(category => category.prefixes.some(prefix => prefix.endsWith('.') ? action.startsWith(prefix) : action === prefix)) || { id: action.split('.')[0], label: action.split('.')[0] };

const value = item => item === null || item === undefined ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item);
const named = (label, name) => name ? `${label} ${name}` : label;
const permission = p => p ? `${p} access` : 'no access';
// [past tense, infinitive, object]. The repository is never part of the phrase; readers add it where the scope does not already say it.
const phrases = {
  'installation_policy.update': ['changed', 'change', e => `installation policy ${e.subject}`],
  'feature_policy.update': ['changed', 'change', e => `the ${e.subject.replace(/^feature:/, '')} feature policy${e.after ? ' to ' + value(e.after).replace(/^FEATURE_POLICY_MODE_/, '').toLowerCase() : ''}`],
  'ai_model.update': ['changed', 'change', e => `the installation AI model for ${e.subject.replace(/^ai\.model\./, '')}`],
  'repository_ai_model.update': ['changed', 'change', e => `the AI model for ${e.subject.replace(/^ai\.model\./, '')}${e.after ? ' to ' + value(e.after) : ''}`],
  'repository_feature.update': [e => e.after === false ? 'turned off' : 'turned on', e => e.after === false ? 'turn off' : 'turn on', e => `the ${e.subject.replace(/^feature:/, '')} feature`],
  'installation.access_denied': ['opened', 'open', e => e.subject],
  'runner_pool.create': ['created', 'create', e => named('runner pool', e.subject)], 'runner_pool.update': ['updated', 'update', e => named('runner pool', e.subject)],
  'runner.enroll': ['enrolled', 'enroll', e => named('runner', e.subject) + (e.after?.pool ? ` in pool ${e.after.pool}` : '')],
  'runner.rotate_credential': ['rotated the credential of', 'rotate the credential of', e => named('runner', e.subject)],
  'runner.drain': ['drained', 'drain', e => named('runner', e.subject)], 'runner.revoke': ['revoked', 'revoke', e => named('runner', e.subject)], 'runner.resume': ['resumed', 'resume', e => named('runner', e.subject)],
  'runner.control': ['changed', 'change', e => named('runner', e.subject)], 'runner.reconcile': ['confirmed cleanup of', 'confirm cleanup of', e => named('runner', e.subject)],
  'org.create': ['created', 'create', e => named('organization', e.subject)], 'user.claim_owner': ['claimed', 'claim', e => named('owner name', e.subject)],
  'repo.create': ['created', 'create', e => named('repository', e.subject)],
  'repo.update_visibility': [e => e.after?.public ? 'made' : 'made', 'change the visibility of', e => e.outcome === 'success' ? `the repository ${e.after?.public ? 'public' : 'private'}` : 'the repository'],
  'repo.update_settings': ['updated', 'update', e => `repository settings (${Object.keys(e.after || {}).join(', ') || 'none'})`], 'repo.update_topics': ['updated', 'update', () => 'repository topics'],
  'repo.update_runner_placement': ['changed', 'change', e => e.outcome === 'success' ? `runner placement from ${e.before?.pool ? 'pool ' + e.before.pool : 'no pool'} to ${e.after?.pool ? 'pool ' + e.after.pool : 'no pool'}` : 'runner placement'],
  'repo.add_member': ['added', 'add', e => `${e.subject}${e.after?.permission ? ' with ' + permission(e.after.permission) : ''}`], 'repo.update_member': ['changed', 'change', e => `${e.subject}’s access${e.after?.permission ? ' to ' + e.after.permission : ''}`],
  'repo.remove_member': ['removed', 'remove', e => e.subject], 'repo.update_actions_settings': ['updated', 'update', () => 'Actions settings'], 'repo.update_merge_settings': ['updated', 'update', () => 'merge settings'],
  'repository_invitation.create': ['invited', 'invite', e => `${e.subject}${e.after?.permission ? ' with ' + permission(e.after.permission) : ''}`], 'repository_invitation.revoke': ['revoked the invitation for', 'revoke the invitation for', e => e.subject],
  'repository_invitation.accept': ['accepted', 'accept', () => 'an invitation'], 'repository_invitation.decline': ['declined', 'decline', () => 'an invitation'],
  'protected_branch.create': ['added', 'add', e => named('branch rule', e.subject)], 'protected_branch.update': ['updated', 'update', e => named('branch rule', e.subject)], 'protected_branch.destroy': ['removed', 'remove', e => named('branch rule', e.subject)],
  'protected_tag.create': ['added', 'add', e => named('tag rule', e.subject)], 'protected_tag.update': ['updated', 'update', e => named('tag rule', e.subject)], 'protected_tag.destroy': ['removed', 'remove', e => named('tag rule', e.subject)],
  'hook.create': ['created', 'create', e => named('webhook', e.subject) + (e.after?.endpointOrigin ? ` to ${e.after.endpointOrigin}` : '')], 'hook.update': ['updated', 'update', e => named('webhook', e.subject)],
  'hook.test': ['sent a test delivery to', 'send a test delivery to', () => 'a webhook'], 'hook.redeliver': ['redelivered', 'redeliver', () => 'a webhook delivery'],
  'repository_secret.create': ['created', 'create', e => named('secret', e.subject)], 'repository_secret.update': ['updated', 'update', e => named('secret', e.subject)], 'repository_secret.destroy': ['deleted', 'delete', e => named('secret', e.subject)],
  'repository_variable.create': ['created', 'create', e => named('variable', e.subject)], 'repository_variable.update': ['updated', 'update', e => named('variable', e.subject)], 'repository_variable.destroy': ['deleted', 'delete', e => named('variable', e.subject)],
  'repository_secret.approve_workflow': ['approved values for', 'approve values for', e => named('workflow', e.subject)], 'repository_secret.revoke_workflow': ['revoked values for', 'revoke values for', e => named('workflow', e.subject)],
  'environment.create': ['created', 'create', e => named('environment', e.subject)], 'environment.update': ['updated', 'update', e => named('environment', e.subject)], 'environment.delete': ['deleted', 'delete', () => 'an environment'],
  'git_credential.create': ['issued', 'issue', e => `${e.after?.access || ''} Git credential ${e.subject}`.trim()], 'git_credential.revoke': ['revoked', 'revoke', e => named('Git credential', e.subject)],
  'git_write.settle': ['settled', 'settle', e => `the unconfirmed push to ${e.subject} as ${e.after?.outcome === 'APPLIED' ? 'applied' : 'not applied'}`],
  'preview.publish': ['published', 'publish', () => 'a preview'], 'preview.renew': ['renewed', 'renew', () => 'a preview'], 'preview.revoke': ['revoked', 'revoke', () => 'a preview'], 'preview.capture': ['captured', 'capture', () => 'a preview snapshot'],
  'release.publish': ['published', 'publish', e => named('release', e.subject)], 'release.update': ['edited', 'edit', e => named('release', e.subject)], 'release.destroy': ['deleted', 'delete', e => named('release', e.subject)],
  'release_asset.upload': ['uploaded', 'upload', e => `${e.after?.asset || 'an asset'} to release ${e.subject}`], 'release_asset.rename': ['renamed', 'rename', e => `an asset of release ${e.subject}`], 'release_asset.destroy': ['deleted', 'delete', e => `an asset of release ${e.subject}`],
  'pull_request.merge': ['merged', 'merge', e => named('pull request', e.subject)], 'pull_request_review.dismiss': ['dismissed', 'dismiss', e => `a review on pull request ${e.subject}`], 'pull_request_review.restore': ['restored', 'restore', e => `a review on pull request ${e.subject}`],
  'label.create': ['created', 'create', e => named('label', e.subject)], 'label.update': ['updated', 'update', e => named('label', e.subject)], 'label.destroy': ['deleted', 'delete', e => named('label', e.subject)],
  'milestone.create': ['created', 'create', e => named('milestone', e.subject)], 'milestone.update': ['updated', 'update', e => named('milestone', e.subject)], 'milestone.destroy': ['deleted', 'delete', e => named('milestone', e.subject)],
  'pipeline_runner.token_create': ['created', 'create', e => `a ${e.subject === 'gitlab-ci' ? 'GitLab' : e.subject === 'forgejo-actions' ? 'Forgejo' : 'runner'} runner registration token`],
  'pipeline_runner.token_revoke': ['revoked', 'revoke', () => 'a runner registration token'], 'pipeline_runner.update': ['updated', 'update', e => named('runner', e.subject)], 'pipeline_runner.delete': ['deleted', 'delete', e => named('runner', e.subject)],
  'actions.dispatch': ['dispatched', 'dispatch', e => named('workflow', e.subject)], 'actions.cancel': ['cancelled', 'cancel', e => named('run', e.subject)], 'actions.rerun': ['re-ran', 're-run', e => named('run', e.subject)],
  'actions.play_job': ['started', 'start', e => named('manual job', e.subject)], 'actions.approve_deployment': ['approved', 'approve', e => named('deployment job', e.subject)], 'actions.reject_deployment': ['rejected', 'reject', e => named('deployment job', e.subject)],
  'agent_host.token_create': ['created', 'create', e => `${e.subject === 'personal' ? 'a personal' : e.subject === 'organization' ? 'an organization' : 'an installation'} agent host registration token`],
  'agent_host.token_revoke': ['revoked', 'revoke', () => 'an agent host registration token'], 'agent_host.update': ['updated', 'update', e => named('agent host', e.subject)], 'agent_host.delete': ['deleted', 'delete', e => named('agent host', e.subject)],
  'agent_task.create': ['assigned', 'assign', e => `${e.after?.kind === 'pull_request' ? 'pull request' : e.after?.kind === 'issue' ? 'issue' : ''} ${e.subject} to a coding agent${e.after?.tool ? ' (' + e.after.tool + ')' : ''}`.replace(/^ /, '')],
  'agent_task.cancel': ['cancelled', 'cancel', () => 'a coding agent task'],
  'agentic_mode.update': ['changed', 'change', e => `agentic mode${e.after?.enabled === true ? ' (on' + (e.after.landWithoutPerson ? ', landing low-risk changes without a person' : '') + ')' : e.after?.enabled === false ? ' (off)' : ''}`],
  'agentic_mode.land': ['landed', 'land', e => named('pull request', e.subject)], 'agentic_mode.auto_land': ['landed', 'land', e => `pull request ${e.subject} without a person`],
  'agentic_mode.revert': ['reverted', 'revert', e => `pull request ${e.subject} after its required checks failed`],
  'automation.create': ['created', 'create', e => named('automation', e.subject)], 'automation.update': ['updated', 'update', e => named('automation', e.subject)],
  'automation.delete': ['deleted', 'delete', e => named('automation', e.subject)], 'automation.enable': ['turned on', 'turn on', e => named('automation', e.subject)],
  'automation.disable': ['turned off', 'turn off', e => named('automation', e.subject)], 'automation.kill_switch': ['engaged the kill switch of', 'engage the kill switch of', e => named('automation', e.subject)],
  'automation.release_kill_switch': ['released the kill switch of', 'release the kill switch of', e => named('automation', e.subject)],
  'automation.run': ['ran', 'run', e => `${named('automation', e.subject)}${e.after?.number ? ' on #' + e.after.number : e.after?.runId ? ' on run ' + e.after.runId : ''}`],
  'api_token.create': ['created', 'create', e => `${e.after?.permission ? e.after.permission + ' ' : ''}API token ${e.subject}`], 'api_token.revoke': ['revoked', 'revoke', e => named('API token', e.subject)],
  'api_token.use_denied': ['was refused with', 'use', e => `${e.after?.agentTaskId ? 'an agent task token' : 'an API token'} (${e.after?.reason === 'branch' ? 'branch outside its pattern' : e.after?.reason === 'permission' ? 'read-only token' : 'repository outside its scope'})`],
  'credential.create': ['added', 'add', e => named('credential', e.subject)], 'credential.rotate': ['rotated', 'rotate', e => named('credential', e.subject)], 'credential.revoke': ['revoked', 'revoke', e => named('credential', e.subject)],
  'credential.grant': ['shared', 'share', e => `credential ${e.subject}${e.after?.grantee ? ' with ' + e.after.grantee : ''}`], 'credential.ungrant': ['stopped sharing', 'stop sharing', e => `credential ${e.subject}${e.after?.grantee ? ' with ' + e.after.grantee : ''}`],
  'credential.use_denied': ['was refused', 'use', e => `credential ${e.subject} (${{ revoked: 'revoked', subscription: 'subscription sign-ins wait for cloud sandboxes', place: 'not allowed in that place', not_granted: 'not shared with this person or repository' }[e.after?.reason] || 'refused'})`],
  'engine.create': ['added', 'add', e => named('engine', e.subject)], 'engine.update': ['updated', 'update', e => named('engine', e.subject)], 'engine.delete': ['deleted', 'delete', e => named('engine', e.subject)],
  'engine_selection.update': ['changed', 'change', e => `the engine for ${e.subject.replace(/^engine:/, '').replaceAll('-', ' ')}`],
  'environment.save': ['saved', 'save', e => named('environment', e.subject)], 'environment.save_value': ['saved', 'save', e => `${e.after?.kind || 'a value'} ${e.subject} of an environment`],
  'ai.run_request': ['requested', 'request', e => `an AI ${e.subject.replaceAll('-', ' ')} run`], 'actions.run_request': ['requested', 'request', e => `a run for pull request ${e.subject}`], 'actions.run_cancel': ['cancelled', 'cancel', () => 'a run'],
};
export function describe(entry) {
  const action = entry.action === 'update' ? 'installation_policy.update' : entry.action;
  const [past, verb, object] = phrases[action] || ['performed', 'perform', e => `${e.action} on ${e.subject}`];
  const word = item => typeof item === 'function' ? item(entry) : item;
  return entry.outcome === 'success' ? `${word(past)} ${object(entry)}` : `tried to ${word(verb)} ${object(entry)}`;
}

const parse = text => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
export function auditEvent(row, env) {
  const client = parse(row.client) || {}, category = categoryOf(row.action);
  const repository = row.repository_name ? `${row.repository_owner || env.WORKSPACE_SLUG}/${row.repository_name}` : client.repository || '';
  const entry = { id: String(row.id), at: row.at, action: row.action, category: category.id, categoryLabel: category.label, actor: row.login || client.login || '', actorEmail: row.actor_email,
    actorKind: client.via || (row.actor_email ? 'person' : 'anonymous'), ...(client.serviceToken ? { serviceToken: client.serviceToken } : {}), scope: row.scope, scopeId: row.scope_id, repository,
    organization: client.organization || row.repository_organization || '', subject: row.subject, before: parse(row.before), after: parse(row.after), widening: Boolean(row.widening),
    outcome: client.outcome || 'success', code: client.code || '', client: clean({ colo: client.colo, country: client.country, ip: client.ip, userAgent: client.userAgent, requestId: client.requestId }) };
  return { ...entry, description: describe(entry) };
}

const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
function filtering(filters = {}, env) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) invalid('Use audit filters.');
  const where = [], values = [];
  if (filters.category) {
    const category = categories.find(item => item.id === filters.category);
    if (!category) invalid('Choose a listed audit category.');
    where.push('(' + category.prefixes.map(prefix => prefix.endsWith('.') ? "a.action LIKE ? ESCAPE '\\'" : 'a.action=?').join(' OR ') + ')');
    values.push(...category.prefixes.map(prefix => prefix.endsWith('.') ? prefix.replaceAll('_', '\\_') + '%' : prefix));
  }
  if (filters.actor) {
    if (typeof filters.actor !== 'string' || filters.actor.length > 254) invalid('Use an account login or email.');
    where.push("(u.login=? OR a.actor_email=? OR json_extract(a.client,'$.login')=?)"); values.push(filters.actor, filters.actor, filters.actor);
  }
  if (filters.repository) {
    if (typeof filters.repository !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/.test(filters.repository)) invalid('Use a repository as owner/name.');
    where.push("a.scope='repository' AND (json_extract(a.client,'$.repository')=? OR (COALESCE(o.slug,?)||'/'||r.name)=?)"); values.push(filters.repository, env.WORKSPACE_SLUG || '', filters.repository);
  }
  if (filters.outcome) {
    if (!['success', 'denied', 'refused', 'unknown'].includes(filters.outcome)) invalid('Choose an outcome.');
    where.push("COALESCE(json_extract(a.client,'$.outcome'),'success')=?"); values.push(filters.outcome);
  }
  if (filters.from) { if (!day(filters.from)) invalid('Use a YYYY-MM-DD start date.'); where.push('a.at>=?'); values.push(filters.from); }
  if (filters.to) { if (!day(filters.to)) invalid('Use a YYYY-MM-DD end date.'); where.push('a.at<?'); values.push(new Date(Date.parse(filters.to + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)); }
  if (filters.query) {
    if (typeof filters.query !== 'string' || filters.query.length > 100) invalid('Search with at most 100 characters.');
    const like = '%' + filters.query.replace(/[\\%_]/g, match => '\\' + match) + '%';
    where.push("(a.action LIKE ? ESCAPE '\\' OR a.subject LIKE ? ESCAPE '\\' OR a.actor_email LIKE ? ESCAPE '\\' OR u.login LIKE ? ESCAPE '\\' OR a.before LIKE ? ESCAPE '\\' OR a.after LIKE ? ESCAPE '\\' OR a.client LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')");
    values.push(...Array(8).fill(like));
  }
  return { where, values };
}

/* The read API. Installation scope: current operations administrators signed in through Access (checked before and after the read).
 * Repository scope: current repository administrators. Organization scope: organization owners, covering the organization's own rows and
 * those of repositories it owns. */
export async function auditAPI(db, env, person, request, body, authorizeRepository) {
  if (!['installation', 'repository', 'organization'].includes(body.scope)) invalid('Choose the installation, an organization or a repository.');
  const where = [], values = [];
  let recheck = async () => {}, scope;
  if (body.scope === 'installation') {
    recheck = async () => { if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.'); };
    await recheck();
    scope = { kind: 'installation', id: env.WORKSPACE_SLUG || '', label: env.WORKSPACE_SLUG || 'Installation' };
  } else if (body.scope === 'repository') {
    const row = await authorizeRepository();
    if (row.role !== 'admin') throw new Fault('permission_denied', 403, 'Repository administrators read the repository audit log.');
    where.push("a.scope='repository' AND a.scope_id=?"); values.push(String(row.id));
    scope = { kind: 'repository', id: String(row.id), label: `${row.owner_slug || env.WORKSPACE_SLUG}/${row.name}` };
  } else {
    if (typeof body.organization !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(body.organization)) invalid('Choose an organization.');
    const owner = await one(db, "SELECT o.id,o.slug FROM native_owners o JOIN native_owner_members m ON m.owner_id=o.id JOIN users u ON u.id=m.user_id WHERE o.slug=? AND o.kind='ORGANIZATION' AND m.user_id=? AND m.role='owner' AND u.active=1", body.organization, person.id);
    if (!owner) throw new Fault('permission_denied', 403, 'Organization owners read the organization audit log.');
    where.push("((a.scope='organization' AND a.scope_id=?) OR (a.scope='repository' AND a.scope_id IN (SELECT CAST(repository_id AS TEXT) FROM repository_owners WHERE owner_id=?)))"); values.push(String(owner.id), owner.id);
    scope = { kind: 'organization', id: String(owner.id), label: owner.slug };
  }
  const filters = filtering(body.filters ?? {}, env), paging = page(body);
  where.push(...filters.where); values.push(...filters.values);
  let results;
  try {
    ({ results } = await db.prepare(`SELECT a.*,u.login,r.name AS repository_name,o.slug AS repository_owner,CASE WHEN o.kind='ORGANIZATION' THEN o.slug END AS repository_organization FROM installation_audit a
      LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN repositories r ON a.scope='repository' AND CAST(r.id AS TEXT)=a.scope_id LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ? OFFSET ?`).bind(...values, paging.limit + 1, paging.offset).all());
  } catch (error) {
    if (/no such table/.test(String(error?.message))) throw new Fault('failed_precondition', 412, 'Apply the schema 30 migration to keep an installation audit log.');
    throw error;
  }
  await recheck();
  if (body.scope === 'repository') await authorizeRepository();
  return reply({ entries: results.slice(0, paging.limit).map(row => auditEvent(row, env)), page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 },
    categories: categories.map(({ id, label }) => ({ id, label })), recording: body.scope === 'installation' ? auditHealth() : { failures: 0, lastFailureAt: '' }, scope });
}
