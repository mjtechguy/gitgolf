import { webhookPolicy } from './webhooks.mjs';
import { emailPolicy } from './email.mjs';
import { Fault, reply } from './common.mjs';
import { release } from './telemetry.mjs';
import { rateLimitService } from './rate-limit.mjs';

export async function operationsAdmin(db, person, request) {
  // Ordinary Git bearer credentials never acquire workspace administration.
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email')) return false;
  return Boolean(await db.prepare('SELECT 1 AS allowed FROM operations_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.active=1 AND u.active=1 AND u.email=?').bind(person.id, request.headers.get('X-Golf-Native-Access-Email')).first());
}

export async function operationsDashboard(db, env, person, request) {
  const requireAdmin = async () => { if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.'); };
  await requireAdmin();
  const stamp = new Date().toISOString(), metrics = [], services = [];
  const metric = (id, label, value, unit = 'count', source = 'D1 workspace inventory', window = 'Current snapshot') => {
    const present = typeof value === 'number' && Number.isFinite(value) && value >= 0;
    metrics.push({ id, label, ...(present ? { value } : {}), unit, source, observedAt: stamp, window, state: present ? 'available' : 'unknown' });
  };
  const queries = [
    ...(webhookPolicy(env) ? [
      ['webhooks.queued', 'Queued webhook deliveries', "SELECT COUNT(*) AS value FROM webhook_deliveries WHERE state IN ('queued','retrying','sending')"],
      ['webhooks.oldest', 'Oldest queued webhook age', "SELECT MIN(created_at) AS value FROM webhook_deliveries WHERE state IN ('queued','retrying','sending')"],
      ['webhooks.failed', 'Failed webhook deliveries', "SELECT COUNT(*) AS value FROM webhook_deliveries WHERE state='failed'"],
    ] : []),
    ...(emailPolicy(env) ? [
      ['email.queued', 'Queued email deliveries', "SELECT COUNT(*) AS value FROM email_deliveries WHERE state IN ('queued','retrying','sending')"],
      ['email.oldest', 'Oldest queued email age', "SELECT MIN(created_at) AS value FROM email_deliveries WHERE state IN ('queued','retrying','sending')"],
      ['email.failed', 'Failed email deliveries', "SELECT COUNT(*) AS value FROM email_deliveries WHERE state='failed'"],
    ] : []),
    ['repositories', 'Repositories', "SELECT COUNT(*) AS value FROM repositories WHERE state='ACTIVE'"],
    ['jobs.queued', 'Queued evidence jobs', "SELECT COUNT(*) AS value FROM evidence_jobs WHERE state='QUEUED'"],
    ['jobs.refused', 'Refused evidence jobs', "SELECT COUNT(*) AS value FROM evidence_jobs WHERE state='REFUSED'"],
    ['jobs.expired', 'Expired evidence jobs', "SELECT COUNT(*) AS value FROM evidence_jobs WHERE state='EXPIRED'"],
    ['tests.failed', 'Failed, timed out or lost test executions', "SELECT COUNT(*) AS value FROM evidence_jobs WHERE test_state IN ('FAILED','TIMED_OUT','LOST')"],
    ['agents.failed', 'Failed, timed out or lost agents', "SELECT COUNT(*) AS value FROM evidence_jobs WHERE agent_state IN ('failed','timed_out','lost')"],
    ['jobs.running', 'Running containers (journal)', "SELECT COUNT(*) AS value FROM evidence_jobs WHERE state='QUEUED' AND (test_state='RUNNING' OR agent_state='RUNNING')"],
    ['jobs.oldest', 'Oldest queued job age', "SELECT MIN(created_at) AS value FROM evidence_jobs WHERE state='QUEUED'"],
    ['reports.bytes', 'Retained report bytes (journal)', "SELECT COALESCE(SUM(report_bytes),0) AS value FROM evidence_jobs WHERE report_key IS NOT NULL"],
    ['previews.active', 'Active previews', "SELECT COUNT(*) AS value FROM previews WHERE purged=0 AND state='READY' AND expires_at>?"],
    ['previews.provisioning', 'Preview provisioning in progress', "SELECT COUNT(*) AS value FROM previews WHERE state='PUBLISHING' AND expires_at>?"],
    ['previews.cleanup', 'Preview cleanup backlog', "SELECT COUNT(*) AS value FROM previews WHERE purged=0 AND (expires_at<=? OR state IN ('REVOKED','EXPIRED'))"],
    ['previews.bytes', 'Preview bundle/capture bytes (journal)', "SELECT COALESCE(SUM(bundle_bytes+COALESCE(capture_bytes,0)),0) AS value FROM previews WHERE purged=0"],
    ['apps.resources', 'Application resources not retired (journal)', "SELECT COUNT(*) AS value FROM app_resources WHERE state!='DELETED'"],
    ['delivery.failed', 'Failed deliveries observed in last 7 days', "SELECT COUNT(*) AS value FROM operations_delivery_failures WHERE observed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"],
    ['indexes.ready', 'Retained read indexes', "SELECT COUNT(*) AS value FROM repository_indexes WHERE state='READY' AND expires_at>?"],
  ];
  const statements = queries.map(([, , sql]) => {const statement=db.prepare(sql);return sql.includes('?') ? statement.bind(stamp) : statement;});
  // One fixed read batch avoids a network round trip for each aggregate.
  const inventory = await db.batch(statements);
  for (const [position, [id, label]] of queries.entries()) {
    const row = inventory[position].results[0];
    let value = row?.value;
    if (id.endsWith('.oldest')) value = value === null ? 0 : Number.isFinite(Date.parse(value)) ? Math.max(0, (Date.now() - Date.parse(value)) / 1000) : undefined;
    metric(id, label, value, id.endsWith('.bytes') ? 'bytes' : id.endsWith('.oldest') ? 'seconds' : 'count');
  }
  const stages = (await db.prepare('SELECT stage,started_at,completed_at,last_success_at,outcome,processed,pending FROM operations_maintenance ORDER BY stage').all()).results;
  if (webhookPolicy(env)) stages.push(...(await db.prepare('SELECT * FROM webhook_maintenance').all()).results);
  if (emailPolicy(env)) stages.push(...(await db.prepare('SELECT * FROM email_maintenance').all()).results);
  for (const id of ['ci','previews','evidence','indexes',...(webhookPolicy(env) ? ['webhooks'] : []),...(emailPolicy(env) ? ['email'] : [])]) {
    const observation = stages.find(row => row.stage === id);
    const stale = observation && Date.now() - Date.parse(observation.completed_at || observation.started_at) > 15 * 60_000;
    services.push({ id: 'maintenance.' + id, label: 'Maintenance · ' + id,
      state: !observation ? 'unknown' : stale || observation.outcome !== 'succeeded' ? 'degraded' : 'available',
      source: 'Hosted maintenance journal', checkedAt: observation?.completed_at || observation?.started_at || '',
      detail: !observation ? 'No maintenance invocation recorded.' : `${observation.outcome}; last success ${observation.last_success_at || 'not observed'}.` });
    if (observation) { metric('maintenance.' + id + '.processed', id + ' maintenance processed', observation.processed, 'count', 'Hosted maintenance journal', 'Last invocation');metrics.at(-1).observedAt = observation.completed_at || observation.started_at;
      metric('maintenance.' + id + '.pending', id + ' maintenance pending', observation.pending, 'count', 'Hosted maintenance journal', 'Last invocation');metrics.at(-1).observedAt = observation.completed_at || observation.started_at; }
  }
  services.unshift({ id:'workers',label:'Golf Worker / workspace Durable Object',state:'available',source:'Current request',checkedAt:stamp,detail:'This workspace control request completed; not fleet-wide health.' },
    {id:'d1',label:'D1',state:'available',source:'Primary-session inventory queries',checkedAt:stamp,detail:'Current workspace query observation; not provider-wide availability.'});
  for (const [id,label,enabled] of [
    ['artifacts','Artifacts canonical Git',Boolean(env.ARTIFACTS)], ['r2','R2 private outputs',Boolean(env.EVIDENCE_BUCKET)],
    ['queues','Queues',Boolean(env.EVIDENCE_QUEUE)], ['dead-letter','Queue failure retention',Boolean(env.EVIDENCE_DEAD_LETTER_QUEUE)], ['workflows','Workflows',Boolean(env.EVIDENCE_WORKFLOW_NAME)],
    ['containers','Containers / Sandbox',Boolean(env.testTasks || env.agentTasks)], ['workers-ai','Workers AI',env.EVIDENCE_ALLOW_AI === 'true'],
    ['ai-gateway','AI Gateway',Boolean(env.EVIDENCE_GATEWAY)], ['access','Access / Zero Trust',Boolean(env.ACCESS_AUD)],
    ['browser','Browser Run',Boolean(env.BROWSER)], ['analytics','Analytics Engine',Boolean(env.USAGE_ANALYTICS)],
    ['platforms','Workers for Platforms',Boolean(env.APP_POLICY)], ['dns','Preview DNS / custom domains',Boolean(env.PREVIEW_ORIGIN)], ['secrets','Secrets Store',Boolean(env.APP_PROVISIONER || env.OPERATIONS_ANALYTICS_TOKEN || env.WEBHOOK_KEY)],
    ['observability','Workers managed observability',env.OPERATIONS_OBSERVABILITY === 'true'],
  ]) services.push({id,label,state:enabled?'configured':'disabled',source:'Installed binding / policy',detail:'Configuration only; provider health and consumption are not probed by this snapshot.'});
  const activity = await db.prepare(`SELECT
    MAX(CASE WHEN state='SUCCEEDED' AND delivery='STARTED' AND report_key IS NOT NULL THEN updated_at END) AS evidence,
    MAX(CASE WHEN state='SUCCEEDED' AND (test_state IN ('PASSED','FAILED') OR agent_state='succeeded') THEN updated_at END) AS containers,
    MAX(CASE WHEN state='SUCCEEDED' AND advice_state='SUCCEEDED' THEN updated_at END) AS ai
    FROM evidence_jobs`).first();
  const previews = await db.prepare(`SELECT
    MAX(CASE WHEN state='READY' AND kind='WORKER' AND purged=0 AND expires_at>? THEN created_at END) AS app,
    MAX(CASE WHEN capture_state='READY' AND capture_hash IS NOT NULL AND purged=0 THEN created_at END) AS browser
    FROM previews`).bind(stamp).first();
  for (const [ids, observed, source, detail] of [
    [['queues','workflows'],activity?.evidence,'Successful queued evidence journal','Queued evidence completed and its private report was published.'],
    [['containers'],activity?.containers,'Completed execution journal','A canonical test or isolated agent execution completed.'],
    [['workers-ai','ai-gateway'],activity?.ai,'Successful advice journal','Approved AI advice completed through the configured gateway.'],
    [['platforms','dns','secrets'],previews?.app,'Ready managed preview journal','Managed Worker allocation completed using the provisioner secret, dispatch namespace and preview domain.'],
    [['browser'],previews?.browser,'Verified private capture journal','A private Browser Run capture was stored and verified.'],
  ]) if (observed && Number.isFinite(Date.parse(observed))) for (const id of ids) {
    const service=services.find(row=>row.id===id);
    if (service?.state==='configured') Object.assign(service,{state:'observed',source,checkedAt:observed,detail:detail+' Historical successful activity; not a current provider health probe.'});
  }
  if (env.ACCESS_AUD) Object.assign(services.find(row=>row.id==='access'),{state:'available',source:'Current authenticated Access request',checkedAt:stamp,detail:'The configured Access gate admitted this mapped human administrator request. Not account-wide Access health.'});
  services.push(rateLimitService(env));
  for (const service of ['artifacts','r2']) {
    const health=await db.prepare('SELECT state,attempted_at,observed_at FROM operations_provider WHERE service=?').bind(service).first();
    const row=services.find(value=>value.id===service);
    if (health && row?.state!=='disabled') {row.state=health.state==='succeeded' && Date.now()-Date.parse(health.observed_at)<20*60_000?'available':'degraded';row.source='Retained read-only service probe';row.checkedAt=health.attempted_at;row.detail='Last successful read probe: '+(health.observed_at || 'not observed')+'. Not provider-wide health or write readiness.';}
  }
  const provider = await db.prepare("SELECT * FROM operations_provider WHERE service='workers'").first();
  const stale = !provider?.observed_at || Date.now() - Date.parse(provider.observed_at) > 20 * 60_000;
  services.push({id:'provider.analytics',label:'Workers Analytics API',state:!env.OPERATIONS_ANALYTICS_TOKEN?'disabled':!provider?'configured':provider.state!=='succeeded'||stale?'degraded':'available',source:'Retained Cloudflare Analytics response',checkedAt:provider?.attempted_at || '',detail:'Last successful Worker observations are retained; provider ingestion may lag.'});
  for (const [id,label,field] of [['provider.requests','Worker requests','requests'],['provider.errors','Worker errors','errors'],['provider.subrequests','Worker subrequests','subrequests']]) {
    metric(id,label,provider?.[field] ?? undefined,'count','Cloudflare Workers adaptive analytics',provider?.window_start ? provider.window_start+' – '+provider.window_end : 'Not observed');
    metrics.at(-1).observedAt=provider?.observed_at || '';
  }
  for (const [id,label,unit] of [['storage.bytes','Provider storage bytes','bytes'],['billing.estimated','Estimated provider spend','USD'],['billing.actual','Provider billed spend','USD']])
    metric(id,label,undefined,unit,'Provider collector not installed','Not observed');
  await requireAdmin();
  if (env.performanceSnapshot) metrics.push(...env.performanceSnapshot());
  return reply({ runtimeProfile:'cloudflare-native',scope:'workspace:' + env.WORKSPACE_SLUG,generatedAt:stamp,release,services,metrics,
    notices:['Workspace inventory only. Configured bindings are not verified provider health.','Retained report bytes and container states come from journals, not provider billing or live container probes.','Worker traffic is available only with the optional Analytics Read collector; storage billing, spend and organization drilldown are not collected.'] });
}

export async function maintenanceStage(env, stage, action) {
  const db = env.DB.withSession('first-primary'), started = new Date().toISOString();
  const table = stage === 'webhooks' ? 'webhook_maintenance' : stage === 'email' ? 'email_maintenance' : 'operations_maintenance';
  await db.prepare(`INSERT INTO ${table}(stage,started_at,outcome) VALUES(?,?,'running') ON CONFLICT(stage) DO UPDATE SET started_at=excluded.started_at,completed_at=NULL,outcome='running',processed=NULL,pending=NULL`).bind(stage,started).run();
  let result, failed = false;
  try { result = await action(); } catch { failed = true; }
  const pending = failed ? null : Number.isSafeInteger(result?.pending) && result.pending >= 0 ? result.pending : 0;
  const processed = failed ? null : ['admitted','purged','resent','stopped','deleted','published','expired','processed'].reduce((sum,key) => sum + (Number.isSafeInteger(result?.[key]) && result[key] >= 0 ? result[key] : 0), 0);
  const outcome = failed ? 'failed' : pending ? 'degraded' : 'succeeded';
  const completed = new Date().toISOString();
  await db.prepare(`UPDATE ${table} SET completed_at=?,outcome=?,processed=?,pending=?,last_success_at=CASE WHEN ?='succeeded' THEN ? ELSE last_success_at END WHERE stage=? AND started_at=? AND outcome='running'`).bind(completed,outcome,processed,pending,outcome,completed,stage,started).run();
  if (failed) throw Error('Golf maintenance stage failed: ' + stage);
  return result;
}

export async function runMaintenance(env, stages) {
  let failures = 0;
  for (const [stage,action] of stages) { try { await maintenanceStage(env,stage,action); } catch { failures++; } }
  if (failures) throw Error('Golf maintenance has failed stages. Inspect the operations dashboard.');
}
