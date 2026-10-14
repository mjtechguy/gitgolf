import { Fault, reply, invalid, uuidOK, digest, page } from './common.mjs';
import { release, configuration } from './telemetry.mjs';
import { operationsAdmin } from './operations.mjs';
import { webhookPolicy, approvedOrigin } from './webhooks.mjs';
import { emailPolicy } from './email.mjs';
import { rateLimitPolicy } from './rate-limit.mjs';
import { evidencePolicy } from './evidence.mjs';
import { testPolicy } from './test-policy.mjs';
import { agentPolicy } from './agent-policy.mjs';
import { previewPolicy } from './delivery.mjs';
import { appPolicy } from './app-policy.mjs';
import { executionValueState } from './execution-values.mjs';
import { previewSlots } from './environments.mjs';
import { defaultAppearance } from './public.mjs';

// Newest first: the first table present names the applied schema.
const schemaTables = [[35, 'repository_ai_models'], [32, 'ai_runs'], [31, 'policy_revisions'], [30, 'installation_audit'], [29, 'discussion_attachment_operations'], [28, 'repository_release_operations'], [27, 'email_deliveries'], [26, 'execution_value_brokers'],
  [25, 'repository_execution_policy'], [24, 'pull_merge_operations'], [23, 'repository_environment_operations'], [22, 'repository_visibility'], [21, 'native_owners'],
  [20, 'gitlab_runner_jobs'], [19, 'native_runner_pools'], [18, 'pull_review_operations'], [17, 'git_credentials'], [16, 'repository_rule_operations'],
  [15, 'webhook_subscriptions'], [14, 'discussion_events'], [13, 'discussion_resources'], [12, 'repository_invitations'], [11, 'repository_access_operations'],
  [10, 'operations_maintenance'], [9, 'repository_index_budget']];
export async function schemaVersion(db) {
  const columns = async table => (await db.prepare(`PRAGMA table_info(${table})`).all()).results;
  for (const [version, table] of schemaTables) if ((await columns(table)).length) return version;
  if ((await columns('repository_indexes')).some(column => column.name === 'payload_hash')) return 8;
  return (await columns('repositories')).some(column => column.name === 'default_branch') ? 7 : 6;
}

const yes = value => value ? 'Yes' : 'No';
const day = () => new Date().toISOString().slice(0, 10);
// One read of today's use; a table from a later schema that is absent reads as unknown, never as zero.
async function usage(db) {
  const count = async (sql, ...values) => { try { return (await db.prepare(sql).bind(...values).first())?.n ?? 0; } catch { return null; } };
  const today = day();
  return { webhooks: await count('SELECT COALESCE(SUM(attempts),0) AS n FROM webhook_daily WHERE day=?', today),
    email: await count('SELECT COALESCE(SUM(attempts),0) AS n FROM email_daily WHERE day=?', today),
    accepted: await (async () => { try { return await db.prepare('SELECT sender,accepted_at FROM email_acceptance').all(); } catch { return { results: [] }; } })(),
    evidence: await count('SELECT count(*) AS n FROM evidence_jobs WHERE created_at>=?', today),
    previews: await count('SELECT count(*) AS n FROM previews WHERE purged=0') };
}
const used = (value, limit) => value === null ? 'Not readable on this schema' : `${value} of ${limit} used today`;

// Every value here is one the Worker holds without a secret: binding presence, never Secrets Store references, Access audiences or the app secret.
export function installationGroups(env, today) {
  const item = (id, label, service, state, values, settingsKey, alchemy, reason, capability = '') => ({ id, label, service, state, capability, values: values.filter(Boolean), change: { settingsKey, alchemy }, reason });
  const state = (policy, present) => policy ? 'configured' : present ? 'refused' : 'unallocated';
  const webhooks = webhookPolicy(env), email = emailPolicy(env), limit = rateLimitPolicy(env), evidence = evidencePolicy(env), tests = testPolicy(env), agents = agentPolicy(env),
    previews = previewPolicy(env), apps = appPolicy(env), values = executionValueState(env), team = env.ACCESS_TEAM_DOMAIN || '';
  const accepted = email && today.accepted.results.find(row => row.sender === email.sender);
  return [
    { id: 'installation', label: 'Installation and sign-in', items: [
      item('workspace', 'Workspace', 'Workers and Durable Objects', 'configured', [{ label: 'Workspace', value: env.WORKSPACE_SLUG || '' }, { label: 'Public origin', value: env.PUBLIC_ORIGIN || '' },
        env.ACCOUNT_ID && { label: 'Cloudflare account', value: env.ACCOUNT_ID }, env.ARTIFACTS_NAMESPACE && { label: 'Artifacts namespace', value: env.ARTIFACTS_NAMESPACE }], 'origin, workspace', 'prepare', 'Fixed when the installation is provisioned.'),
      item('access', 'Cloudflare Access sign-in', 'Access / Zero Trust', env.ACCESS_AUD && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) ? 'configured' : env.ACCESS_AUD ? 'refused' : 'unallocated',
        [{ label: 'Team domain', value: team || 'Not set' }, { label: 'Application audience', value: env.ACCESS_AUD ? 'Configured (not shown)' : 'Not set' }], 'access_team_domain, access_aud', 'prepare',
        'People sign in through Access; the audience tag is a credential check and is never displayed.'),
      item('public', 'Public repositories', 'Workers', env.PUBLIC_REPOSITORIES === 'true' ? 'configured' : 'unallocated',
        [{ label: 'Anonymous browsing and cloning', value: env.PUBLIC_REPOSITORIES === 'true' ? 'Allowed for repositories an administrator publishes' : 'Off' },
          { label: 'First-visit appearance', value: defaultAppearance.test(env.DEFAULT_APPEARANCE || '') ? env.DEFAULT_APPEARANCE : 'Golf (built-in default)' }], 'public_repositories, default_appearance', 'enable-public',
        'Publishing needs a repository administrator; collaboration and execution keep repository grants.', 'repository.public-source'),
      item('rate-limit', 'Anonymous rate limit', 'Workers rate limiting', state(limit, env.ANONYMOUS_READ_LIMIT && env.PUBLIC_REPOSITORIES === 'true'),
        [limit && { label: 'Limit', value: `About ${limit.limit} requests per ${limit.period} seconds per client network and location` }, !limit && { label: 'Limit', value: env.ANONYMOUS_READ_LIMIT ? (env.PUBLIC_REPOSITORIES === 'true' ? 'Installed value is not valid' : 'Installed, but public repositories are off') : 'Not installed' }],
        'anonymous_rate_limit', 'enable-rate-limit', 'Counts are approximate and per Cloudflare location; signed-in, credentialed and runner requests are never counted.'),
    ] },
    { id: 'automation', label: 'Automation', items: [
      item('evidence', 'Pull-request evidence', 'Queues, Workflows and R2', state(evidence, env.EVIDENCE_QUEUE_NAME || env.EVIDENCE_WORKFLOW_NAME),
        [{ label: 'Queue', value: env.EVIDENCE_QUEUE_NAME || 'Not set' }, { label: 'Workflow', value: env.EVIDENCE_WORKFLOW_NAME || 'Not set' }, { label: 'Failure queue', value: env.EVIDENCE_DEAD_LETTER_QUEUE || 'Not retained' },
          evidence && { label: 'Daily admissions', value: env.EVIDENCE_DAILY_LIMIT, usage: used(today.evidence, env.EVIDENCE_DAILY_LIMIT) }], 'evidence', 'prepare',
        'Every test, agent and advice run is admitted here; private reports go to R2.', 'native-pr-evidence'),
      item('tests', 'Container tests', 'Containers', state(tests && evidence, env.TEST_EXECUTION_ENABLED === 'true'),
        [{ label: 'Approved source', value: env.TEST_WORKFLOW_FORMAT ? `${env.TEST_WORKFLOW_FORMAT} workflow ${env.TEST_WORKFLOW_PATH || ''}`.trim() : env.TEST_MODULE ? `Python module ${env.TEST_MODULE}` : 'None' },
          env.TEST_IMAGE_REF && { label: 'Image', value: env.TEST_IMAGE_REF }, { label: 'Automatic push tests', value: yes(env.CI_AUTO === 'true') }], 'tests, automatic_ci', 'enable-workflow',
        'The approved path is hashed into each run’s policy identity, so it changes only with a deploy.', 'native-pr-tests'),
      item('advice', 'AI advice', 'Workers AI and AI Gateway', state(evidence && env.EVIDENCE_ALLOW_AI === 'true' && env.AI && env.EVIDENCE_GATEWAY, env.EVIDENCE_ALLOW_AI === 'true'),
        [{ label: 'Allowed at deploy', value: yes(env.EVIDENCE_ALLOW_AI === 'true') }, { label: 'Gateway', value: env.EVIDENCE_GATEWAY || 'Not set' }], 'evidence.allow_ai, evidence.gateway', 'enable-ai',
        'Advisory only; private source reaches Workers AI through the gateway, whose caps are set in Cloudflare.'),
      item('agents', 'Agent proposals', 'Containers and Workers AI', state(agents, env.AGENT_PATH), [{ label: 'Editable path', value: env.AGENT_PATH || 'Not set' }], 'agent_path', 'enable-ai --agent-path',
        'Agents edit one approved path in an isolated fork; the path is part of the policy identity.', 'native-pr-agents'),
      item('previews', 'Protected previews', 'Workers, R2 and Access', state(previews, env.PREVIEW_ORIGIN),
        [{ label: 'Preview origin', value: env.PREVIEW_ORIGIN || 'Not set' }, previews && { label: 'Static directory', value: env.PREVIEW_PATH },
          previews && { label: 'Lifetime', value: `${Math.round(Number(env.PREVIEW_TTL) / 60)} minutes` }, previews && { label: 'Installation slots', value: String(previewSlots), usage: today.previews === null ? undefined : `${today.previews} held now` },
          previews && { label: 'Published automatically', value: yes(env.PREVIEW_AUTO === 'true') }, previews && { label: 'Visual snapshots', value: yes(env.BROWSER && env.PREVIEW_BROWSER === 'true') }],
        'previews', 'prepare', 'The preview Worker, its origin and Access application are created at deploy.', 'native-pr-previews'),
      item('apps', 'Worker applications', 'Workers for Platforms', state(apps, env.APP_POLICY),
        apps ? [{ label: 'Dispatch namespace', value: apps.namespace }, { label: 'Entry', value: apps.entry }, { label: 'Lifetime', value: `${Math.round(apps.ttl / 60)} minutes` }] : [{ label: 'Allocation', value: env.APP_POLICY ? 'Installed value is not valid' : 'Not installed' }],
        'apps', 'prepare', 'Each application gets a private database and file bucket that are removed on expiry.', 'native-pr-apps'),
      item('secrets', 'Repository secrets and variables', 'Secrets Store', values.ready ? 'configured' : env.EXECUTION_VALUE_KEY ? 'refused' : 'unallocated',
        [{ label: 'Encryption key', value: env.EXECUTION_VALUE_KEY?.get ? 'Bound (value never shown)' : 'Not bound' }, !values.ready && { label: 'Why not ready', value: values.reason }], 'execution_values', 'enable-secrets',
        'Values are released only to approved pull-request jobs.', 'settings.repository-secrets'),
    ] },
    { id: 'integrations', label: 'Integrations', items: [
      item('webhooks', 'Webhooks', 'Workers and Secrets Store', state(webhooks, env.WEBHOOK_POLICY),
        webhooks ? [{ label: 'Approved origins', value: webhooks.origins.join('\n') }, { label: 'Daily delivery attempts', value: String(webhooks.dailyLimit), usage: used(today.webhooks, webhooks.dailyLimit) }]
          : [{ label: 'Policy', value: env.WEBHOOK_POLICY ? 'Installed value or its encryption key is not valid' : 'Not installed' }],
        'webhooks', 'enable-webhooks --origin', 'Repository administrators can subscribe only to these exact HTTPS origins.', 'settings.repository-webhooks'),
      item('email', 'Email notifications', 'Email Service', state(email, env.EMAIL_POLICY),
        email ? [{ label: 'Sender', value: email.sender }, { label: 'Daily send attempts', value: String(email.dailyLimit), usage: used(today.email, email.dailyLimit) },
          { label: 'Provider acceptance', value: accepted ? `First accepted ${accepted.accepted_at.slice(0, 10)}` : 'None recorded yet' }]
          : [{ label: 'Policy', value: env.EMAIL_POLICY ? 'Installed value, binding or Access sign-in is missing' : 'Not installed' }],
        'email', 'enable-email --email-limit', 'Mail goes only to each subscriber’s own Access sign-in address.', 'repository.email-notifications'),
    ] },
    { id: 'operations', label: 'Operations', items: [
      item('observability', 'Observability', 'Workers Logs and Analytics', env.OPERATIONS_OBSERVABILITY === 'true' || env.OPERATIONS_ANALYTICS_TOKEN || env.USAGE_ANALYTICS ? 'configured' : 'unallocated',
        [{ label: 'Request logs', value: yes(env.OPERATIONS_OBSERVABILITY === 'true') }, { label: 'Workers Analytics collector', value: env.OPERATIONS_ANALYTICS_TOKEN ? 'Token bound (never shown)' : 'Not installed' },
          { label: 'Evidence metrics dataset', value: env.USAGE_ANALYTICS ? 'Bound' : 'Not bound' }], 'operations, analytics_dataset', 'enable-observability, enable-analytics',
        'Provider usage and billing are not collected.', 'operations.dashboard'),
      item('registry', 'Package registry', 'Containers registry', env.REGISTRY && env.REGISTRY_ORIGIN ? 'configured' : 'unallocated',
        [{ label: 'Provider', value: env.REGISTRY_PROVIDER === 'cloudflare' ? 'Cloudflare managed' : env.REGISTRY ? 'External' : 'Not installed' }, env.REGISTRY_ORIGIN && { label: 'Registry origin', value: env.REGISTRY_ORIGIN },
          { label: 'Job publishing', value: yes(env.REGISTRY_CI_ENABLED === 'true') }], 'registry', 'prepare', 'Image publishing needs an approved test allocation.', 'repository.packages'),
    ] },
  ];
}

// Installation policy: operator-approved values that are editable in the product inside the deploy allocation.
// Add a key by adding an entry here; installation_settings has no CHECK on keys, so a new key needs no migration.
// deploy(env) is the deploy default and ceiling (null: not allocated, not editable). validate(env, value, deploy) returns the canonical value or
// throws invalid_argument. effective(env, stored, deploy) narrows a stored value to the current deploy bounds and throws on a value it cannot
// read (the deploy value then applies). widening(before, after) needs typed confirmation and a recent Access sign-in. overlay(value, env) is
// what the point of use reads. effect states what happens to queued, in-flight and new work.
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const toggle = (label, deploy, off, effect, widensWhenOff = false) => ({ label, deploy: env => deploy(env) ? { enabled: true } : null,
  validate(env, value) { if (!shape(value, ['enabled']) || typeof value.enabled !== 'boolean') invalid(`Choose whether ${label.toLowerCase()} is on.`); return { enabled: value.enabled }; },
  effective(env, value) { if (typeof value?.enabled !== 'boolean') throw Error('unreadable'); return { enabled: value.enabled }; },
  widening: (before, after) => widensWhenOff ? before.enabled && !after.enabled : !before.enabled && after.enabled,
  overlay: value => value.enabled ? {} : off, effect });
export const installationPolicies = {
  webhooks: { label: 'Webhooks', deploy: env => { const p = webhookPolicy(env); return p && { origins: p.origins, dailyLimit: p.dailyLimit }; },
    bounds: () => ({ origins: 'One to 32 public HTTPS origins. Never this installation or its subdomains, the preview origin, Cloudflare Access or Artifacts.', dailyLimit: [1, 5000] }),
    validate(env, value) {
      if (!shape(value, ['origins', 'dailyLimit']) || !Array.isArray(value.origins) || value.origins.length < 1 || value.origins.length > 32 || new Set(value.origins).size !== value.origins.length) invalid('Use one to 32 distinct origins.');
      for (const origin of value.origins) if (!approvedOrigin(env, origin)) invalid(`${String(origin).slice(0, 300)} cannot receive webhooks: use a public HTTPS origin such as https://hooks.example.com that is not this installation, its previews, Cloudflare Access or Artifacts.`);
      if (!int(value.dailyLimit, 1, 5000)) invalid('Daily delivery attempts must be a whole number from 1 to 5000.');
      return { origins: [...value.origins], dailyLimit: value.dailyLimit };
    },
    // An origin that no longer passes (for example, it became the preview origin) is dropped, never replaced by the deploy list.
    effective: (env, value, deploy) => ({ origins: value.origins.filter(origin => approvedOrigin(env, origin)).slice(0, 32), dailyLimit: int(value.dailyLimit, 1, 5000) ? value.dailyLimit : deploy.dailyLimit }),
    widening: (before, after) => after.origins.some(origin => !before.origins.includes(origin)) || after.dailyLimit > before.dailyLimit,
    overlay: value => ({ WEBHOOK_POLICY: JSON.stringify(value) }),
    effect: { queued: 'Queued and retrying deliveries to a removed origin fail at their next attempt (destination unavailable).', inFlight: 'A delivery already sending completes.', new: 'Subscriptions to a removed origin can no longer be saved. A new limit applies at the next claim.' } },
  email: { label: 'Email notifications', deploy: env => { const p = emailPolicy(env); return p && { enabled: true, dailyLimit: p.dailyLimit }; },
    bounds: () => ({ dailyLimit: [1, 5000] }),
    validate(env, value) { if (!shape(value, ['enabled', 'dailyLimit']) || typeof value.enabled !== 'boolean' || !int(value.dailyLimit, 1, 5000)) invalid('Choose on or off and daily send attempts from 1 to 5000.'); return { enabled: value.enabled, dailyLimit: value.dailyLimit }; },
    effective(env, value) { if (typeof value?.enabled !== 'boolean' || !int(value.dailyLimit, 1, 5000)) throw Error('unreadable'); return { enabled: value.enabled, dailyLimit: value.dailyLimit }; },
    widening: (before, after) => after.enabled && !before.enabled || after.dailyLimit > before.dailyLimit,
    overlay: (value, env) => ({ EMAIL_POLICY: JSON.stringify({ ...JSON.parse(env.EMAIL_POLICY), dailyLimit: value.dailyLimit }), ...(value.enabled ? {} : { EMAIL_DISABLED: 'installation' }) }),
    effect: { queued: 'Turned off: queued and retrying mail is cancelled at the next drain (disabled by installation policy).', inFlight: 'A message already sending completes.', new: 'Turned off: nothing new is sent and email settings are unavailable. A new limit applies at the next claim.' } },
  advice: toggle('AI advice', env => evidencePolicy(env) && env.EVIDENCE_ALLOW_AI === 'true' && env.AI && env.EVIDENCE_GATEWAY, { EVIDENCE_ALLOW_AI: 'false' },
    { queued: 'Turned off: queued runs that asked for advice are refused at their next step. Agent proposals need AI advice and stop with it.', inFlight: 'An advice call already started completes.', new: 'Turned off: new runs asking for advice or agent proposals are refused.' }),
  agents: toggle('Agent proposals', env => agentPolicy(env), { AGENT_EXECUTION_ENABLED: 'false' },
    { queued: 'Turned off: queued proposals are refused at their next step.', inFlight: 'Running agents are not stopped.', new: 'Turned off: new proposals are refused.' }),
  previews: { label: 'Protected previews', deploy: env => previewPolicy(env) ? { lifetimeSeconds: Number(env.PREVIEW_TTL), concurrency: previewSlots } : null,
    bounds: (env, deploy) => ({ lifetimeSeconds: [60, deploy.lifetimeSeconds], concurrency: [1, previewSlots] }),
    validate(env, value, deploy) {
      if (!shape(value, ['lifetimeSeconds', 'concurrency']) || !int(value.lifetimeSeconds, 60, deploy.lifetimeSeconds) || !int(value.concurrency, 1, previewSlots)) invalid(`Use a lifetime from 60 to ${deploy.lifetimeSeconds} seconds and 1 to ${previewSlots} concurrent previews.`);
      return { lifetimeSeconds: value.lifetimeSeconds, concurrency: value.concurrency };
    },
    effective(env, value, deploy) { if (!int(value?.lifetimeSeconds, 60, 14400) || !int(value.concurrency, 1, previewSlots)) throw Error('unreadable'); return { lifetimeSeconds: Math.min(value.lifetimeSeconds, deploy.lifetimeSeconds), concurrency: value.concurrency }; },
    widening: (before, after) => after.lifetimeSeconds > before.lifetimeSeconds || after.concurrency > before.concurrency,
    overlay: value => ({ PREVIEW_TTL: String(value.lifetimeSeconds), PREVIEW_SLOTS: String(value.concurrency) }),
    effect: { queued: 'Previews already published keep their expiry.', inFlight: 'A publication already admitted completes with the lifetime it was admitted with.', new: 'New publications and renewals use the new lifetime; a new preview is refused while the installation holds that many.' } },
  'rate-limit': toggle('Anonymous rate limit', env => rateLimitPolicy(env), { ANONYMOUS_LIMIT_OFF: 'true' },
    { queued: 'Nothing is queued by the limit.', inFlight: 'Requests already admitted are unaffected.', new: 'The next anonymous request is limited, or not.' }, true),
  evidence: { label: 'Daily evidence admissions', deploy: env => evidencePolicy(env) ? { dailyLimit: Number(env.EVIDENCE_DAILY_LIMIT) } : null,
    bounds: (env, deploy) => ({ dailyLimit: [1, deploy.dailyLimit] }),
    validate(env, value, deploy) { if (!shape(value, ['dailyLimit']) || !int(value.dailyLimit, 1, deploy.dailyLimit)) invalid(`Daily admissions must be a whole number from 1 to the deploy value ${deploy.dailyLimit}.`); return { dailyLimit: value.dailyLimit }; },
    effective(env, value, deploy) { if (!int(value?.dailyLimit, 1, 50)) throw Error('unreadable'); return { dailyLimit: Math.min(value.dailyLimit, deploy.dailyLimit) }; },
    widening: (before, after) => after.dailyLimit > before.dailyLimit,
    overlay: value => ({ EVIDENCE_DAILY_LIMIT: String(value.dailyLimit) }),
    effect: { queued: 'Runs already admitted continue.', inFlight: 'Running jobs are not stopped.', new: 'The next admission counts against the new limit, including automatic push tests and previews.' } },
};
export const locked = env => env.INSTALLATION_POLICY_EDITING === 'false';
// Before schema 30 there are no rows, so every deploy value applies.
export async function installationSettings(db) {
  try { return new Map((await db.prepare('SELECT s.key,s.value,s.version,s.updated_at,u.login AS updated_by FROM installation_settings s LEFT JOIN users u ON u.id=s.updated_by').all()).results.map(row => [row.key, row])); }
  catch { return null; }
}
function current(env, key, row) {
  const policy = installationPolicies[key], deploy = policy.deploy(env);
  if (!deploy || !row || locked(env)) return { deploy, value: deploy, unreadable: false };
  try { return { deploy, value: policy.effective(env, JSON.parse(row.value), deploy), unreadable: false }; } catch { return { deploy, value: deploy, unreadable: true }; }
}
export function installationOverlay(env, rows) {
  const overlay = { installationOff: [], installationSchema: Boolean(rows) };
  if (!rows || locked(env)) return overlay;
  for (const key of Object.keys(installationPolicies)) {
    const { value } = current(env, key, rows.get(key));
    if (!value || !rows.has(key)) continue;
    Object.assign(overlay, installationPolicies[key].overlay(value, env));
    if (value.enabled === false) overlay.installationOff.push(key);
  }
  return overlay;
}
// Requests read the effective policy in core before their route runs; background stages read it at their own start.
export const withInstallationPolicy = async (env, db = env.DB.withSession('first-primary')) => ({ ...env, ...installationOverlay(env, await installationSettings(db)) });

/* auditStatement(db, entry) returns one prepared INSERT into installation_audit for the caller's own D1 batch.
 * Place it immediately after the statement whose change it records: by default it inserts only when that statement changed exactly one row
 * (changes()=1), so a refused or stale write leaves no audit row; pass guarded: false to record unconditionally. Rows can never be updated or
 * deleted (triggers abort). entry: { actor: { id }, actorEmail, scope: 'installation' | 'organization' | 'repository' | …, scopeId,
 * subject: the setting or feature id, action: a short verb such as 'update', before, after: any JSON values, widening: boolean,
 * operationId?: unique per change (replays are refused by the unique index), client?: { colo, country } }. */
export function auditStatement(db, entry) {
  return db.prepare(`INSERT INTO installation_audit(at,actor_id,actor_email,scope,scope_id,subject,action,before,after,widening,operation_id,client) SELECT ?,?,?,?,?,?,?,?,?,?,?,?${entry.guarded === false ? '' : ' WHERE changes()=1'}`)
    .bind(new Date().toISOString(), entry.actor.id, entry.actorEmail || '', entry.scope, String(entry.scopeId ?? ''), entry.subject, entry.action,
      entry.before === undefined ? null : JSON.stringify(entry.before), entry.after === undefined ? null : JSON.stringify(entry.after), entry.widening ? 1 : 0, entry.operationId || null, JSON.stringify(entry.client || {}));
}
const auditRow = row => ({ id: String(row.id), at: row.at, actor: row.login || '', actorEmail: row.actor_email, scope: row.scope, scopeId: row.scope_id, subject: row.subject, action: row.action,
  before: row.before === null ? null : JSON.parse(row.before), after: row.after === null ? null : JSON.parse(row.after), widening: Boolean(row.widening), client: JSON.parse(row.client || '{}') });
const auditSelect = 'SELECT a.*,u.login FROM installation_audit a LEFT JOIN users u ON u.id=a.actor_id';
const editing = env => locked(env) ? { enabled: false, reason: 'Installation policy is locked at deploy (policy_editing: false). Deploy values apply and every change needs a deploy.' }
  : { enabled: true, reason: 'Operations administrators signed in through Access can narrow these values at any time. Widening one needs typed confirmation and an Access sign-in from the last 10 minutes.' };
function policyView(env, key, row) {
  const policy = installationPolicies[key], { deploy, value, unreadable } = current(env, key, row);
  return deploy && { key, label: policy.label, version: String(row?.version || 0), value, deploy, source: row && !locked(env) ? 'installation' : 'deploy', unreadable,
    updatedAt: row?.updated_at || '', updatedBy: row?.updated_by || '', bounds: policy.bounds?.(env, deploy) || {}, effect: policy.effect, confirmation: key };
}
const stale = () => { throw new Fault('failed_precondition', 412, 'This setting changed since you read it. Refresh before editing.'); };
const recentSignIn = 600;
export const clientHeaders = request => Object.fromEntries([['colo', /^[A-Z]{3}$/], ['country', /^[A-Z]{2}$/]]
  .map(([name, pattern]) => [name, request.headers.get(name === 'colo' ? 'X-Golf-Native-Access-Colo' : 'X-Golf-Native-Access-Country') || '', pattern]).filter(([, value, pattern]) => pattern.test(value)).map(([name, value]) => [name, value]));

// Operations administrators only, checked before and after the reads like the dashboard, so a revocation during the read returns nothing.
export async function installationAPI(db, env, person, request, body, read) {
  const requireAdmin = async () => { if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.'); };
  await requireAdmin();
  if (read && body.action === 'read') {
    const today = await usage(db), schema = await schemaVersion(db), rows = await installationSettings(db), effective = { ...env, ...installationOverlay(env, rows) };
    // States describe the deploy allocation; values are what applies now.
    const allocated = installationGroups(env, today).flatMap(group => group.items), groups = installationGroups(effective, today);
    for (const item of groups.flatMap(group => group.items)) {
      item.state = allocated.find(row => row.id === item.id).state;
      if (Object.hasOwn(installationPolicies, item.id)) item.policy = policyView(env, item.id, rows?.get(item.id)) || undefined;
    }
    const recent = rows ? (await db.prepare(auditSelect + ' ORDER BY a.id DESC LIMIT 10').all()).results.map(auditRow) : [];
    await requireAdmin();
    return reply({ generatedAt: new Date().toISOString(), release, configuration, schema, workspace: env.WORKSPACE_SLUG, publicOrigin: env.PUBLIC_ORIGIN, demoStopAt: env.DEMO_STOP_AT || '',
      editing: rows ? editing(env) : { enabled: false, reason: 'Apply the schema 30 migration to edit installation policy. Deploy values apply.' }, groups, recent });
  }
  if (read && body.action === 'audit') {
    const paging = page(body);
    let results = [];
    try { ({ results } = await db.prepare(auditSelect + ' ORDER BY a.id DESC LIMIT ? OFFSET ?').bind(paging.limit + 1, paging.offset).all()); }
    catch { throw new Fault('failed_precondition', 412, 'Apply the schema 30 migration to keep an installation audit log.'); }
    await requireAdmin();
    return reply({ entries: results.slice(0, paging.limit).map(auditRow), page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } });
  }
  if (read || body.action !== 'update') invalid('Use the read or audit action on the read route and the update action on the write route.');
  if (locked(env)) throw new Fault('failed_precondition', 412, editing(env).reason);
  const policy = Object.hasOwn(installationPolicies, body.key) ? installationPolicies[body.key] : null;
  if (!policy) invalid('Choose an installation setting.');
  if (!uuidOK(body.operationId) || typeof body.expectedVersion !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(body.expectedVersion)) invalid('Provide an operation ID and the version you read.');
  const rows = await installationSettings(db);
  if (!rows) throw new Fault('failed_precondition', 412, 'Apply the schema 30 migration to edit installation policy.');
  const { deploy, value: before } = current(env, body.key, rows.get(body.key));
  if (!deploy) throw new Fault('failed_precondition', 412, `${policy.label} is not allocated on this installation; allocating it needs a deploy.`);
  const after = policy.validate(env, body.value, deploy), inputHash = await digest(JSON.stringify([body.key, body.expectedVersion, after]));
  const previous = await db.prepare('SELECT * FROM installation_operations WHERE operation_id=?').bind(body.operationId).first();
  if (previous) {
    if (previous.actor_id !== person.id || previous.input_hash !== inputHash) throw new Fault('already_exists', 409, 'This operation ID belongs to another change.');
    return reply(JSON.parse(previous.receipt));
  }
  const version = Number(body.expectedVersion);
  if ((rows.get(body.key)?.version || 0) !== version) stale();
  const widening = policy.widening(before, after);
  if (widening) {
    if (body.confirmation !== body.key) throw new Fault('failed_precondition', 412, `This change widens ${policy.label.toLowerCase()}. Type ${body.key} to confirm it.`);
    const issued = Number(request.headers.get('X-Golf-Native-Access-Issued-At'));
    if (!Number.isInteger(issued) || Date.now() / 1000 - issued > recentSignIn) throw new Fault('failed_precondition', 412, 'Widening changes need an Access sign-in from the last 10 minutes. Sign out of Access, sign in again and retry.');
  }
  const time = new Date().toISOString(), text = JSON.stringify(after), email = request.headers.get('X-Golf-Native-Access-Email');
  const admin = 'EXISTS(SELECT 1 FROM operations_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.active=1 AND u.active=1 AND u.email=?)';
  const receipt = { key: body.key, version: String(version + 1), value: after, widening, operationId: body.operationId, at: time };
  // One batch: the revision-fenced write, its audit row and the receipt. A stale version or a revoked administrator writes none of them.
  await db.batch([
    version ? db.prepare(`UPDATE installation_settings SET value=?,version=version+1,updated_by=?,updated_at=? WHERE key=? AND version=? AND ${admin}`).bind(text, person.id, time, body.key, version, person.id, email)
      : db.prepare(`INSERT INTO installation_settings(key,value,version,updated_by,updated_at) SELECT ?,?,1,?,? WHERE ${admin} ON CONFLICT(key) DO NOTHING`).bind(body.key, text, person.id, time, person.id, email),
    auditStatement(db, { actor: person, actorEmail: email, scope: 'installation', scopeId: env.WORKSPACE_SLUG, subject: body.key, action: 'update', before, after, widening, operationId: body.operationId, client: clientHeaders(request) }),
    db.prepare('INSERT INTO installation_operations(operation_id,actor_id,input_hash,receipt,created_at) SELECT ?,?,?,?,? WHERE changes()=1').bind(body.operationId, person.id, inputHash, JSON.stringify(receipt), time),
  ]);
  if (!await db.prepare('SELECT 1 AS saved FROM installation_operations WHERE operation_id=?').bind(body.operationId).first()) { await requireAdmin(); stale(); }
  return reply(receipt);
}
