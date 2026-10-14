import { Fault, reply } from './common.mjs';
import { release, configuration } from './telemetry.mjs';
import { operationsAdmin } from './operations.mjs';
import { webhookPolicy } from './webhooks.mjs';
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
const schemaTables = [[29, 'discussion_attachment_operations'], [28, 'repository_release_operations'], [27, 'email_deliveries'], [26, 'execution_value_brokers'],
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

// Operations administrators only, checked before and after the reads like the dashboard, so a revocation during the read returns nothing.
export async function installationAPI(db, env, person, request, body, read) {
  const requireAdmin = async () => { if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.'); };
  await requireAdmin();
  if (!read || body.action !== 'read') throw new Fault('invalid_argument', 400, 'Use the read action on the read route.');
  const today = await usage(db), schema = await schemaVersion(db), groups = installationGroups(env, today);
  await requireAdmin();
  return reply({ generatedAt: new Date().toISOString(), release, configuration, schema, workspace: env.WORKSPACE_SLUG, publicOrigin: env.PUBLIC_ORIGIN, demoStopAt: env.DEMO_STOP_AT || '', groups });
}
