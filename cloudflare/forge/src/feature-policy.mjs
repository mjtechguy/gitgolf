import { Fault, deny, invalid, unsupported, uuidOK, digest } from './common.mjs';
import { ownerJoin } from './owners.mjs';
import { testPolicy } from './test-policy.mjs';
import { evidencePolicy } from './evidence.mjs';
import { agentPolicy } from './agent-policy.mjs';
import { previewPolicy } from './delivery.mjs';
import { webhookPolicy } from './webhooks.mjs';
import { emailPolicy } from './email.mjs';
import { executionValueState } from './execution-values.mjs';
import { operationsAdmin } from './operations.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';
import { auditStatement, clientHeaders, locked } from './installation.mjs';
import { settingsAuthority } from './repository-settings.mjs';
import { aiAllocation } from './ai.mjs';
import { searchUnallocated } from './search.mjs';

// GitHub-style features: operator allocation ∩ installation ∩ organization ∩ repository choice ∩ dependencies.
// Missing rows mean ALLOWED and enabled, so the migration alone changes nothing. Turning a feature off never deletes data.
// allocated(env) is true or the operator's reason; choice says repository administrators may turn it off themselves.
const catalogue = [
  { id: 'pull-requests', label: 'Pull requests', plural: true, group: 'Collaboration', requires: [], choice: true, allocated: () => true },
  { id: 'issues', label: 'Issues', plural: true, group: 'Collaboration', requires: [], choice: true, allocated: () => true },
  // PR evidence runs are pull-request runs, so that lane needs pull requests; Actions pipelines also run on push and dispatch.
  { id: 'actions', label: 'Actions', group: 'Automation', requires: env => pipelinePolicy(env) ? [] : ['pull-requests'], choice: true, allocated: env => pipelinePolicy(env) || Boolean(testPolicy(env)) && evidencePolicy(env) || 'The operator has not allocated Actions pipelines (runner protocol and R2 log bucket) or pull-request test execution on this installation.' },
  { id: 'secrets', label: 'Secrets and variables', plural: true, group: 'Automation', requires: ['actions'], choice: true, allocated: env => executionValueState(env).ready || executionValueState(env).reason },
  { id: 'previews', label: 'Previews and environments', plural: true, group: 'Automation', requires: ['actions'], choice: true, allocated: env => previewPolicy(env) || 'The operator has not allocated protected previews (preview Worker, origin and Access application) on this installation.' },
  { id: 'agents', label: 'Agent proposals', plural: true, group: 'Automation', requires: ['actions', 'pull-requests'], choice: true, allocated: env => evidencePolicy(env) && agentPolicy(env) || 'The operator has not allocated native agent proposals on this installation.' },
  { id: 'advice', label: 'AI review advice', group: 'Automation', requires: ['pull-requests'], choice: true, allocated: env => evidencePolicy(env) && env.EVIDENCE_ALLOW_AI === 'true' && Boolean(env.AI && env.EVIDENCE_GATEWAY) || 'The operator has not approved Workers AI advice for pull-request evidence on this installation.' },
  { id: 'ai-review-drafts', label: 'AI review drafts', plural: true, group: 'Automation', requires: ['pull-requests'], choice: true, allocated: env => aiAllocation(env) || 'The operator has not approved Workers AI runs (Workers AI, the private AI Gateway and the AI workflow) on this installation.' },
  { id: 'merge', label: 'Merge', group: 'Collaboration', requires: ['pull-requests'], choice: true, allocated: () => true },
  { id: 'attachments', label: 'Discussion attachments', plural: true, group: 'Collaboration', requires: [], choice: true, allocated: env => Boolean(env.EVIDENCE_BUCKET) || 'Discussion attachments need the private R2 bucket binding on this installation.' },
  { id: 'wiki', label: 'Wiki', group: 'Collaboration', requires: [], choice: false, allocated: () => 'Cloudflare native has no wiki service yet.' },
  { id: 'webhooks', label: 'Webhooks', plural: true, group: 'Integrations', requires: [], choice: true, allocated: env => Boolean(webhookPolicy(env)) || 'The operator has not configured a webhook encryption key and approved destination origins on this installation.' },
  { id: 'email', label: 'Email notifications', plural: true, group: 'Integrations', requires: [], choice: true, allocated: env => Boolean(emailPolicy(env)) || 'The operator has not configured Cloudflare Email Service with Access sign-in on this installation.' },
  { id: 'releases', label: 'Releases', plural: true, group: 'Distribution', requires: [], choice: true, allocated: env => Boolean(env.EVIDENCE_BUCKET) || 'Releases need the private R2 bucket binding on this installation.' },
  { id: 'packages', label: 'Packages', plural: true, group: 'Distribution', requires: [], choice: true, allocated: env => Boolean(env.REGISTRY && env.REGISTRY_ORIGIN) || 'The operator has not connected an OCI registry to this installation.' },
  { id: 'semantic-search', label: 'Semantic search', group: 'Automation', requires: [], choice: true, allocated: env => searchUnallocated(env) || true },
  { id: 'public-repositories', label: 'Public repositories', plural: true, group: 'Distribution', requires: [], choice: false, allocated: env => env.PUBLIC_REPOSITORIES === 'true' || 'The operator has not enabled public repositories for this deployment.' },
  // Workers AI runs: each needs the operator's AI allocation (approved AI, private gateway, AI workflow) and the feature it works on.
  { id: 'ai-triage', label: 'AI label suggestions', plural: true, group: 'Automation', requires: ['issues'], choice: true, allocated: env => aiAllocation(env) || 'The operator has not allocated Workers AI runs (approved Workers AI, its private gateway and the AI workflow) on this installation.' },
  { id: 'ai-release-notes', label: 'AI release notes drafts', plural: true, group: 'Automation', requires: ['releases'], choice: true, allocated: env => aiAllocation(env) || 'The operator has not allocated Workers AI runs (approved Workers AI, its private gateway and the AI workflow) on this installation.' },
  // Coding CLIs on machines users connect (docs/AGENT_HOSTS.md): no operator binding, so always allocated; assigned from issues.
  { id: 'agent-hosts', label: 'Coding agents on your machines', plural: true, group: 'Automation', requires: ['issues'], choice: true, allocated: () => true },
  // API tokens and remote MCP (docs/AGENT_ACCESS.md): no operator binding; off here refuses every golf_pat_ call on the repository.
  { id: 'agent-access', label: 'API tokens and MCP', plural: true, group: 'Integrations', requires: [], choice: true, allocated: () => true },
  // Agentic mode (docs/AGENTIC_MODE.md): each repository turns it on in its own setting, off by default; policy may only forbid it.
  { id: 'agentic-mode', label: 'Agentic mode', group: 'Automation', requires: ['pull-requests'], choice: false, allocated: () => true },
  // Automations (docs/AUTOMATIONS.md): no operator binding, so always allocated; every automation is created off. Off here stops every run in scope.
  { id: 'automations', label: 'Automations', plural: true, group: 'Automation', requires: [], choice: true, allocated: () => true },
];
// Features a policy can turn off but never require: each repository keeps its own setting (visibility, the agentic mode switch).
const neverRequired = { 'public-repositories': 'Public repositories can never be required: each repository keeps its own visibility.',
  'agentic-mode': 'Agentic mode can never be required: each repository administrator turns it on in the repository settings.' };
const known = new Map(catalogue.map(feature => [feature.id, feature]));
const needs = (feature, env) => typeof feature.requires === 'function' ? feature.requires(env) : feature.requires;
const modes = ['UNSPECIFIED', 'DISABLED', 'ALLOWED', 'ENFORCED'], rank = { DISABLED: 0, ALLOWED: 1, ENFORCED: 2 };
const be = feature => feature.plural ? 'are' : 'is';
const named = (value, prefix, names) => typeof value === 'string' ? names.indexOf(value.replace(prefix, '')) : value;
const human = request => !request.headers.has('Authorization') && !request.headers.has('CF-Access-Client-Id') && !request.headers.has('CF-Access-Client-Secret') && Boolean(request.headers.get('X-Golf-Native-Access-Email'));

// Joined into each repository read (alias r for the repository, o for its owner), so a gate costs no extra round trip.
export const featureColumns = `(SELECT json_group_array(json_array(p.scope,p.feature,p.mode)) FROM feature_policies p WHERE p.scope='installation' AND p.scope_id='' OR p.scope='organization' AND o.kind='ORGANIZATION' AND p.scope_id=CAST(o.id AS TEXT)) AS feature_policy,
  (SELECT json_group_array(json_array(f.feature,f.enabled,f.version)) FROM repository_features f WHERE f.repository_id=r.id AND f.artifact_name=r.artifact_name) AS feature_choice,
  (SELECT json_array(e.manual,e.push,e.artifact_name=r.artifact_name,e.version) FROM repository_execution_policy e WHERE e.repository_id=r.id) AS feature_execution,
  (SELECT revision FROM policy_revisions WHERE scope='repository' AND scope_id=CAST(r.id AS TEXT)) AS feature_revision`;
// Anonymous source reads, discovery and listings of public repositories stop where a policy turned them off; the visibility row is kept.
export const publicAllowed = `NOT EXISTS(SELECT 1 FROM feature_policies fp WHERE fp.feature='public-repositories' AND fp.mode='DISABLED' AND (fp.scope='installation' AND fp.scope_id=''
  OR fp.scope='organization' AND fp.scope_id IN (SELECT CAST(no.id AS TEXT) FROM repository_owners rno JOIN native_owners no ON no.id=rno.owner_id WHERE rno.repository_id=r.id AND no.kind='ORGANIZATION')))`;
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const levels = { INSTALLATION: 'installation', ORGANIZATION: 'organization', REPOSITORY: 'repository' };

// The effective state of every feature for one repository, from the joined columns. subject reads "this repository" or "every repository".
export function effectiveFeatures(env, row, subject = 'this repository') {
  const policies = parse(row.feature_policy, []), choices = new Map(parse(row.feature_choice, []).map(([id, enabled, version]) => [id, { enabled, version }]));
  const execution = parse(row.feature_execution, null), organization = row.owner_kind === 'ORGANIZATION', result = new Map();
  const mode = (scope, id) => { const value = policies.find(([s, f]) => s === scope && f === id)?.[2] || 'ALLOWED'; return Object.hasOwn(neverRequired, id) && value === 'ENFORCED' ? 'ALLOWED' : value; };
  for (const feature of catalogue) {
    const { id, label } = feature, installation = mode('installation', id), owner = organization ? mode('organization', id) : 'ALLOWED';
    const enforced = installation === 'ENFORCED' || owner === 'ENFORCED', allocated = feature.allocated(env);
    // Actions writes through the repository execution switch: either kind of run on means Actions is on; another artifact's row enables nothing.
    const enabled = !feature.choice || (id === 'actions' ? !execution || Boolean(execution[2] && (execution[0] || execution[1])) : choices.get(id)?.enabled !== 0);
    const version = id === 'actions' ? execution?.[3] || 0 : choices.get(id)?.version || 0;
    const requires = needs(feature, env), blocked = requires.map(required => result.get(required)).find(required => !required.effective);
    let decidedBy, reason, effective = false;
    if (allocated !== true) [decidedBy, reason] = ['OPERATOR', allocated];
    // A dependency the operator never allocated makes this feature unallocated too: no policy decided it.
    else if (blocked?.decidedBy === 'OPERATOR') [decidedBy, reason] = ['OPERATOR', `${label} need${feature.plural ? '' : 's'} ${blocked.label}, which the operator has not allocated on this installation.`];
    else if (installation === 'DISABLED') [decidedBy, reason] = ['INSTALLATION', `${label} ${be(feature)} turned off for ${subject} by the installation policy.`];
    else if (owner === 'DISABLED') [decidedBy, reason] = ['ORGANIZATION', `${label} ${be(feature)} turned off for ${subject} by the organization policy.`];
    else if (!enforced && !enabled) [decidedBy, reason] = ['REPOSITORY', `${label} ${be(feature)} turned off for ${subject} by the repository policy.`];
    else if (blocked) [decidedBy, reason] = ['DEPENDENCY', `${label} ${be(feature)} turned off for ${subject} because ${blocked.label} ${be(known.get(blocked.id))} off (${levels[blocked.decidedBy] || 'dependency'} policy).`];
    else {
      effective = true;
      decidedBy = enforced ? installation === 'ENFORCED' ? 'INSTALLATION' : 'ORGANIZATION' : feature.choice ? 'REPOSITORY' : 'INSTALLATION';
      reason = enforced ? `${label} ${be(feature)} required for ${subject} by the ${levels[decidedBy]} policy.` : feature.choice ? `${label} ${be(feature)} on; the installation policy lets repository administrators turn ${feature.plural ? 'them' : 'it'} off.` : `${label} ${be(feature)} allowed by the installation policy.`;
    }
    result.set(id, { id, label, group: feature.group, requires, effective, decidedBy, reason, repositoryEnabled: enabled, version,
      canChange: feature.choice && allocated === true && installation !== 'DISABLED' && owner !== 'DISABLED' && !enforced, installation, organization: owner });
  }
  return result;
}

const loaded = new WeakMap();
// Rows from authorizedRepository carry the policy columns; background rows are completed with one read.
export async function repositoryFeatures(db, env, row) {
  if (loaded.has(row)) return loaded.get(row);
  const source = row.feature_policy !== undefined ? row : await db.prepare(`SELECT r.id,o.kind AS owner_kind,${featureColumns} FROM repositories r ${ownerJoin} WHERE r.id=?`).bind(row.id ?? row).first();
  const features = effectiveFeatures(env, source || {});
  if (typeof row === 'object') loaded.set(row, features);
  return features;
}
// A feature turned off by a policy (not one the operator never allocated: existing checks keep their own answers there).
export async function featureOff(db, env, row, id) {
  const feature = (await repositoryFeatures(db, env, row)).get(id);
  return feature && !feature.effective && feature.decidedBy !== 'OPERATOR' ? feature : null;
}
export async function requireFeature(db, env, row, id) {
  const off = id && await featureOff(db, env, row, id);
  if (off) throw new Fault('failed_precondition', 412, off.reason);
}
// Evidence admission: the request names which governed features the job would use.
export async function admissionFeatures(db, env, row, { tests, agent, advice }) {
  for (const [wanted, id] of [[tests || agent, 'actions'], [agent, 'agents'], [advice, 'advice']]) if (wanted) await requireFeature(db, env, row, id);
}
// Background evidence steps re-check what an admitted job still uses; a refused job keeps its stored rows.
export async function evidenceRefused(db, env, row, job, snapshot) {
  for (const [used, id] of [[snapshot.execution || snapshot.agent, 'actions'], [snapshot.agent, 'agents'], [job.advice_state !== 'NONE', 'advice']]) if (used && await featureOff(db, env, row, id)) return true;
  return false;
}
// Outbox drains cancel queued deliveries of a repository whose feature is off, with a code readers can tell apart.
const outboxes = { webhooks: 'webhook_deliveries', email: 'email_deliveries' };
export async function deliveryCancelled(db, env, repositoryId, id, deliveryId) {
  if (!await featureOff(db, env, repositoryId, id)) return false;
  await db.prepare(`UPDATE ${outboxes[id]} SET state='cancelled',failure_code='disabled_by_policy',completed_at=? WHERE id=? AND state IN ('queued','retrying')`).bind(new Date().toISOString(), deliveryId).run();
  return true;
}

// Issues and pull requests share discussion methods. Each shared method names the kind it acts on (pullRequest), and every
// module's own lookup requires the stored discussion to be of that kind, so the kind is settled before the method acts.
const issueMethods = new Set(['CreateIssue', 'GetIssue', 'ListIssues', 'UpdateIssue', 'ListIssueTemplates']);
const pullMethods = new Set(['CreatePullRequest', 'GetPullRequest', 'ListPullRequests', 'UpdatePullRequest', 'GetPullRequestDiscussion', 'CreatePullRequestReview', 'GetPullRequestReviewMutation', 'ListPullRequestReviews', 'ListPullRequestChecks', 'ListPullRequestCommits', 'GetPullRequestDiff']);
const pullServices = new Set(['PullReviewRequestService', 'PullReviewAuthoringService', 'PullMergeObservationService']);
const sharedMethods = new Set(['CreateIssueComment', 'ListIssueComments', 'GetDiscussionEngagement', 'ListDiscussionTimeline']);
export async function discussionFeatures(db, person, row, service, method, body) {
  if (service === 'StandardPullMergeService') return ['merge'];
  if (pullServices.has(service) || pullMethods.has(method)) return ['pull-requests'];
  if (issueMethods.has(method)) return ['issues'];
  const target = body.target || body;
  if (sharedMethods.has(method) || method === 'SubmitDiscussionResourceOperation' && (target.number || target.issueId)) return [target.pullRequest ? 'pull-requests' : 'issues'];
  // A stored receipt is resolved to the discussion it changed.
  if (method === 'GetIssueMutation') {
    const op = await db.prepare('SELECT result_kind,result_id FROM collaboration_operations WHERE user_id=? AND operation_key=? AND repository_id=?').bind(person.id, body.idempotencyKey ?? '', row.id).first();
    if (!op) return [];
    if (op.result_kind !== 'comment') return [op.result_kind === 'issue' ? 'issues' : 'pull-requests'];
    const kind = (await db.prepare('SELECT d.kind FROM discussion_comments c JOIN discussions d ON d.id=c.discussion_id WHERE c.id=?').bind(op.result_id).first())?.kind;
    return kind ? [kind === 'pull' ? 'pull-requests' : 'issues'] : [];
  }
  return [];
}

// Installation-wide decisions show in the capability list, so blocked pages and settings navigation name the level.
const capabilityFeatures = { 'native-pr-tests': 'actions', 'actions.pipelines': 'actions', 'actions.forgejo-runner': 'actions', 'actions.artifacts': 'actions', 'actions.environments': 'actions', 'settings.pipeline-runners': 'actions', 'native-ci-automatic': 'actions', 'settings.repository-execution-policy': 'actions', 'settings.repository-secrets': 'secrets',
  'native-pr-previews': 'previews', 'native-preview-browser': 'previews', 'native-pr-apps': 'previews', 'settings.repository-environments': 'previews', 'native-pr-agents': 'agents',
  'discussion.attachments': 'attachments', 'settings.repository-webhooks': 'webhooks', 'repository.email-notifications': 'email', 'repository.releases': 'releases',
  'repository.packages': 'packages', 'pull.ai-review-drafts': 'ai-review-drafts', 'repository.semantic-search': 'semantic-search', 'ci.registry-publish': 'packages', 'repository.public-source': 'public-repositories', 'pull.merge': 'merge', 'discussion.templates': 'issues', 'discussion.ai-triage': 'ai-triage', 'repository.ai-release-notes': 'ai-release-notes', 'agents.hosts': 'agent-hosts', 'agents.ssh-hosts': 'agent-hosts', 'agents.mcp': 'agent-access', 'repository.agentic-mode': 'agentic-mode',
  ...Object.fromEntries(['pull.merge-observation', 'pull.review-requests', 'pull.review-lifecycle', 'pull.pending-reviews', 'pull.codeowners'].map(id => [id, 'pull-requests'])) };
export async function policyCapabilities(db, env, capabilities) {
  const { results } = await db.prepare("SELECT scope,feature,mode FROM feature_policies WHERE scope='installation' AND scope_id=''").all();
  const installation = effectiveFeatures(env, { feature_policy: JSON.stringify(results.map(row => [row.scope, row.feature, row.mode])) }, 'every repository');
  return [...capabilities.map(capability => {
    const feature = installation.get(capabilityFeatures[capability.id]);
    return feature && !feature.effective && ['INSTALLATION', 'DEPENDENCY'].includes(feature.decidedBy) && capability.state !== 'CAPABILITY_STATE_DISABLED' ? { ...capability, state: 'CAPABILITY_STATE_DISABLED', reason: feature.reason } : capability;
  }), { id: 'settings.feature-policy', label: 'Features and policies', state: 'CAPABILITY_STATE_READY', reason: 'Operations administrators signed in through Access choose per feature whether it is off, allowed or required for every repository; repository administrators turn allowed features on or off. Turning a feature off keeps its data. Organization policies are not available yet.' }];
}

function wireFeature(feature) {
  return { feature: feature.id, effective: feature.effective, decidedBy: 'FEATURE_DECIDER_' + feature.decidedBy, reason: feature.reason, repositoryEnabled: feature.repositoryEnabled,
    canChange: feature.canChange, revision: String(feature.version), label: feature.label, group: feature.group, requires: feature.requires,
    required: feature.effective && (feature.installation === 'ENFORCED' || feature.organization === 'ENFORCED') };
}
async function repositoryRevision(row) {
  const execution = parse(row.feature_execution, null);
  return digest(JSON.stringify(['native.repository-features.v1', row.id, row.artifact_name, row.feature_revision || 0, execution?.[3] || 0]));
}
export const repositoryFeatureMethods = new Set(['GetRepositoryFeatures', 'UpdateRepositoryFeatures']);
const repositoryStale = () => { throw new Fault('failed_precondition', 412, 'Repository features, a policy or repository access changed. Refresh before editing.'); };
export async function repositoryFeatureService(db, env, person, row, request, method, body) {
  if (!repositoryFeatureMethods.has(method)) unsupported();
  if (body.repositoryId !== undefined && body.repositoryId !== String(row.id)) deny();
  const features = await repositoryFeatures(db, env, row);
  if (method === 'UpdateRepositoryFeatures') {
    // A current administrator under a verified human Access sign-in; bearer and service tokens never change features.
    if (!human(request) || row.role !== 'admin') throw new Fault('permission_denied', 403, 'Repository features change only under a verified Access sign-in by a current repository administrator.');
    const changes = body.changes;
    if (Object.keys(body).some(key => !['repository', 'repositoryId', 'expectedRevision', 'changes'].includes(key)) || body.repositoryId !== String(row.id) || typeof body.expectedRevision !== 'string' ||
        !Array.isArray(changes) || !changes.length || changes.length > catalogue.length || new Set(changes.map(change => change?.feature)).size !== changes.length ||
        changes.some(change => !change || Object.keys(change).some(key => !['feature', 'enabled'].includes(key)) || !known.has(change.feature) || change.enabled !== undefined && typeof change.enabled !== 'boolean'))
      invalid('Name each feature once with its new setting, the repository ID and the observed revision.');
    if (body.expectedRevision !== await repositoryRevision(row)) repositoryStale();
    const wanted = changes.map(change => [features.get(change.feature), change.enabled === true]).filter(([feature, enabled]) => feature.repositoryEnabled !== enabled);
    if (!wanted.length) invalid('Change at least one feature.');
    for (const [feature] of wanted) if (!feature.canChange) throw new Fault('failed_precondition', 412, feature.effective ? `${feature.reason} The repository cannot turn ${feature.label} off.` : feature.reason);
    const authority = settingsAuthority(person, row), time = new Date().toISOString(), revision = Number(row.feature_revision || 0), execution = parse(row.feature_execution, null);
    // The first statement rechecks authority, the observed revision and the Actions switch identity; every later write needs it to have applied.
    const statements = [db.prepare(`INSERT INTO policy_revisions(scope,scope_id,revision) SELECT 'repository',?,? WHERE ${authority.sql}
      AND COALESCE((SELECT revision FROM policy_revisions WHERE scope='repository' AND scope_id=?),0)=? AND COALESCE((SELECT version FROM repository_execution_policy WHERE repository_id=?),0)=?
      AND NOT EXISTS(SELECT 1 FROM repository_execution_policy WHERE repository_id=? AND artifact_name!=?)
      ON CONFLICT(scope,scope_id) DO UPDATE SET revision=excluded.revision WHERE policy_revisions.revision=?`)
      .bind(String(row.id), revision + 1, ...authority.values, String(row.id), revision, row.id, execution?.[3] || 0, row.id, row.artifact_name, revision)];
    // Each write is followed by its audit row, recorded only when that write applied.
    for (const [feature, enabled] of wanted) statements.push(feature.id === 'actions'
      // Actions writes through the repository execution switch: both kinds of run on, or both off.
      ? db.prepare(`INSERT INTO repository_execution_policy(repository_id,artifact_name,version,manual,push,updated_by,updated_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1
          ON CONFLICT(repository_id) DO UPDATE SET version=excluded.version,manual=excluded.manual,push=excluded.push,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .bind(row.id, row.artifact_name, (execution?.[3] || 0) + 1, Number(enabled), Number(enabled), person.id, time)
      : db.prepare(`INSERT INTO repository_features(repository_id,artifact_name,feature,enabled,version,updated_by,updated_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1
          ON CONFLICT(repository_id,feature) DO UPDATE SET artifact_name=excluded.artifact_name,enabled=excluded.enabled,version=repository_features.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .bind(row.id, row.artifact_name, feature.id, Number(enabled), feature.version + 1, person.id, time),
      auditStatement(db, { actor: person, actorEmail: request.headers.get('X-Golf-Native-Access-Email'), scope: 'repository', scopeId: String(row.id), subject: 'feature:' + feature.id, action: 'repository_feature.update', before: feature.repositoryEnabled, after: enabled, widening: enabled, client: clientHeaders(request) }));
    const saved = await db.batch(statements);
    if (saved.some(result => result.meta.changes !== 1)) repositoryStale();
    const fresh = await db.prepare(`SELECT r.id,r.artifact_name,o.kind AS owner_kind,${featureColumns} FROM repositories r ${ownerJoin} WHERE r.id=?`).bind(row.id).first();
    return repositoryFeatureService(db, env, person, { ...row, ...fresh }, request, 'GetRepositoryFeatures', { repositoryId: String(row.id) });
  }
  return { repositoryId: String(row.id), features: [...features.values()].map(wireFeature), revision: await repositoryRevision(row), canEdit: row.role === 'admin' && human(request) };
}

// Installation scope. Organization policies arrive with organization settings; the model already narrows by them.
export const featurePolicyMethods = new Set(['GetFeaturePolicy', 'UpdateFeaturePolicy']);
const policyStale = () => { throw new Fault('failed_precondition', 412, 'Feature policy changed. Refresh before editing.'); };
async function installationPolicy(db, env) {
  const [{ results: rows }, { results: repositories }, revision] = await Promise.all([
    db.prepare("SELECT p.*,u.login FROM feature_policies p LEFT JOIN users u ON u.id=p.updated_by WHERE p.scope='installation' AND p.scope_id=''").all(),
    db.prepare(`SELECT r.id,r.artifact_name,o.kind AS owner_kind,COALESCE(v.is_public,0) AS is_public,${featureColumns} FROM repositories r ${ownerJoin} LEFT JOIN repository_visibility v ON v.repository_id=r.id WHERE r.state='ACTIVE'`).all(),
    db.prepare("SELECT revision FROM policy_revisions WHERE scope='installation' AND scope_id=''").first()]);
  // Agentic mode is on where the policy allows it and the repository turned it on (schema 41; before it, nowhere).
  const agentic = new Set(await (async () => { try { return (await db.prepare('SELECT repository_id FROM repository_agentic_settings WHERE enabled=1').all()).results.map(row => row.repository_id); } catch { return []; } })());
  const reach = repositories.map(row => [row, effectiveFeatures(env, row)]), latest = rows.reduce((last, row) => !last || row.updated_at > last.updated_at ? row : last, null);
  const policies = catalogue.map(feature => {
    const row = rows.find(item => item.feature === feature.id), allocated = feature.allocated(env);
    const on = reach.filter(([repository, features]) => features.get(feature.id).effective && (feature.id !== 'public-repositories' || repository.is_public) && (feature.id !== 'agentic-mode' || agentic.has(repository.id))).length;
    return { feature: feature.id, mode: 'FEATURE_POLICY_MODE_' + (row?.mode || 'ALLOWED'), version: String(row?.version || 0), updatedBy: row?.login || '', updatedAt: row?.updated_at || '',
      label: feature.label, group: feature.group, allocated: allocated === true, unavailableReason: allocated === true ? '' : allocated, requires: needs(feature, env),
      repositoriesOn: on, repositoriesTotal: repositories.length, repositoryChoice: feature.choice };
  });
  return { scope: 'FEATURE_POLICY_SCOPE_INSTALLATION', scopeId: '', policies, revision: String(revision?.revision || 0), canEdit: !locked(env), lastChangedAt: latest?.updated_at || '', lastChangedBy: latest?.login || '' };
}
export async function featurePolicyService(db, env, person, request, method, body) {
  if (!featurePolicyMethods.has(method)) unsupported();
  if (named(body.scope, 'FEATURE_POLICY_SCOPE_', ['UNSPECIFIED', 'INSTALLATION', 'ORGANIZATION']) !== 1 || body.organization)
    throw new Fault('unimplemented', 501, 'Organization feature policies are not available on this installation yet; the installation policy applies to every repository.');
  // Only an operations administrator under a verified human Access sign-in reads or changes the installation policy; bearer and service tokens never do.
  if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.');
  if (method === 'GetFeaturePolicy') return installationPolicy(db, env);
  // The deploy-time lock (policy_editing: false) stops changes; policies already saved stay in force, so locking never turns a feature back on.
  if (locked(env)) throw new Fault('failed_precondition', 412, 'Feature policies are locked at deploy (policy_editing: false). Saved policies stay in force; every change needs a deploy.');
  const feature = known.get(body.feature), mode = modes[named(body.mode, 'FEATURE_POLICY_MODE_', modes)];
  if (Object.keys(body).some(key => !['scope', 'organization', 'feature', 'mode', 'expectedVersion', 'confirmation', 'operationId'].includes(key)) || !feature || !rank.hasOwnProperty(mode) ||
      typeof body.expectedVersion !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(body.expectedVersion) || !uuidOK(body.operationId) || body.confirmation !== undefined && typeof body.confirmation !== 'string')
    invalid('Choose a known feature, a mode, the observed version and a UUID v4 operation ID.');
  if (feature.allocated(env) !== true) throw new Fault('failed_precondition', 412, `${feature.label} ${be(feature)} not allocated on this installation; a policy would have no effect.`);
  if (Object.hasOwn(neverRequired, feature.id) && mode === 'ENFORCED') invalid(neverRequired[feature.id]);
  const current = await db.prepare("SELECT * FROM feature_policies WHERE scope='installation' AND scope_id='' AND feature=?").bind(feature.id).first(), before = current?.mode || 'ALLOWED';
  if (body.expectedVersion !== String(current?.version || 0)) policyStale();
  if (before === mode) invalid(`${feature.label} ${be(feature)} already ${mode.toLowerCase()}.`);
  // Widening turns the feature on somewhere it was off: the administrator types the feature id back.
  const widening = rank[mode] > rank[before];
  if (widening && body.confirmation !== feature.id) invalid(`Type ${feature.id} to confirm turning ${feature.label} on where ${be(feature)} now off.`);
  // Widening needs a recent Access sign-in, like installation policy (the public Worker forwards the verified token's issue time).
  const issued = Number(request.headers.get('X-Golf-Native-Access-Issued-At'));
  if (widening && (!Number.isInteger(issued) || Date.now() / 1000 - issued > 600)) throw new Fault('failed_precondition', 412, 'Turning a feature on needs an Access sign-in from the last 10 minutes. Sign out of Access, sign in again and retry.');
  const time = new Date().toISOString(), email = request.headers.get('X-Golf-Native-Access-Email');
  const statements = [
    db.prepare(`INSERT INTO feature_policies(scope,scope_id,feature,mode,version,updated_by,updated_at) SELECT 'installation','',?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM operations_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.active=1 AND u.active=1 AND u.email=?)
      AND COALESCE((SELECT version FROM feature_policies WHERE scope='installation' AND scope_id='' AND feature=?),0)=?
      ON CONFLICT(scope,scope_id,feature) DO UPDATE SET mode=excluded.mode,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE feature_policies.version=?`)
      .bind(feature.id, mode, (current?.version || 0) + 1, person.id, time, person.id, email, feature.id, current?.version || 0, current?.version || 0),
    // Recorded only when the fenced write applied; the revision then advances after it.
    auditStatement(db, { actor: person, actorEmail: email, scope: 'installation', scopeId: env.WORKSPACE_SLUG, subject: 'feature:' + feature.id, action: 'feature_policy.update', before, after: mode, widening, operationId: body.operationId, client: clientHeaders(request) }),
    db.prepare("INSERT INTO policy_revisions(scope,scope_id,revision) SELECT 'installation','',1 WHERE changes()=1 ON CONFLICT(scope,scope_id) DO UPDATE SET revision=revision+1"),
  ];
  const saved = await db.batch(statements);
  if (saved[0].meta.changes !== 1) policyStale();
  const read = await installationPolicy(db, env);
  return { policy: read.policies.find(policy => policy.feature === feature.id), revision: read.revision };
}
