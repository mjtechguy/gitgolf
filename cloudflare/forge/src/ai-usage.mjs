import { Fault, reply, invalid } from './common.mjs';
import { bounded } from './git.mjs';
import { operationsAdmin } from './operations.mjs';
import { aiAllocation, aiDailyLimit } from './ai.mjs';

// AI usage for operations administrators: Golf's own run ledger always, and AI Gateway analytics as a separate panel that is
// degraded until a live read succeeds. Token counts are what each model response reported; Cloudflare billing is authoritative.
const day = 86400_000;
const tokenSum = column => `SUM(COALESCE(json_extract(${column},'$.input_tokens'),json_extract(${column},'$.prompt_tokens'),0))`;
const outputSum = column => `SUM(COALESCE(json_extract(${column},'$.output_tokens'),json_extract(${column},'$.completion_tokens'),0))`;
const totalSum = column => `SUM(COALESCE(json_extract(${column},'$.total_tokens'),COALESCE(json_extract(${column},'$.input_tokens'),json_extract(${column},'$.prompt_tokens'),0)+COALESCE(json_extract(${column},'$.output_tokens'),json_extract(${column},'$.completion_tokens'),0)))`;
const reported = column => `SUM(CASE WHEN ${column} IS NOT NULL AND ${column}!='{}' AND json_valid(${column}) THEN 1 ELSE 0 END)`;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// One query per source. A source whose table is absent on this schema is reported as unreadable, never as zero.
async function ledger(db, since) {
  const sources = [
    ['runs', `SELECT substr(created_at,1,10) AS day,kind AS feature,model,count(*) AS runs,
      SUM(state='SUCCEEDED') AS succeeded,SUM(state='UNKNOWN') AS failed,SUM(state='REFUSED') AS refused,SUM(state IN ('REQUESTED','RESERVED')) AS pending,
      ${tokenSum('usage')} AS input,${outputSum('usage')} AS output,${totalSum('usage')} AS tokens,${reported('usage')} AS reported
      FROM ai_runs WHERE created_at>=? GROUP BY day,kind,model`],
    ['advice', `SELECT substr(created_at,1,10) AS day,'advice' AS feature,COALESCE(json_extract(advice,'$.model'),'@cf/cloudflare/clef') AS model,count(*) AS runs,
      SUM(advice_state='SUCCEEDED') AS succeeded,SUM(advice_state='UNKNOWN') AS failed,0 AS refused,SUM(advice_state IN ('REQUESTED','RESERVED')) AS pending,
      ${tokenSum("json_extract(advice,'$.usage')")} AS input,${outputSum("json_extract(advice,'$.usage')")} AS output,${totalSum("json_extract(advice,'$.usage')")} AS tokens,
      SUM(CASE WHEN json_extract(advice,'$.usage') IS NOT NULL AND json_extract(advice,'$.usage')!='{}' THEN 1 ELSE 0 END) AS reported
      FROM evidence_jobs WHERE created_at>=? AND advice_state!='NONE' GROUP BY day,model`],
    // Agents report one total per proposal (tokens), not input and output.
    ['agents', `SELECT substr(created_at,1,10) AS day,'agents' AS feature,COALESCE(json_extract(agent_result,'$.model'),'@cf/zai-org/glm-5.3-flash') AS model,count(*) AS runs,
      SUM(agent_state='succeeded') AS succeeded,SUM(agent_state IN ('failed','lost','timed_out')) AS failed,SUM(agent_state='cancelled') AS refused,SUM(agent_state IN ('REQUESTED','FORK_PENDING','RUNNING')) AS pending,
      0 AS input,0 AS output,SUM(COALESCE(json_extract(agent_result,'$.tokens'),0)) AS tokens,SUM(json_extract(agent_result,'$.tokens') IS NOT NULL) AS reported
      FROM evidence_jobs WHERE created_at>=? AND agent_state!='NONE' GROUP BY day,model`],
  ];
  const rows = [], unreadable = [];
  for (const [source, sql] of sources) {
    try {
      for (const row of (await db.prepare(sql).bind(since).all()).results) rows.push({ day: row.day, feature: row.feature, source, model: String(row.model || ''),
        runs: count(row.runs), succeeded: count(row.succeeded), failed: count(row.failed), refused: count(row.refused), pending: count(row.pending),
        inputTokens: count(row.input), outputTokens: count(row.output), tokens: count(row.tokens), reported: count(row.reported) });
    } catch { unreadable.push(source); }
  }
  return { rows, unreadable };
}

function limits(env) {
  try {
    const value = JSON.parse(env.AI_GATEWAY_LIMITS);
    if (Number.isInteger(value?.requestsPerMinute) && value.requestsPerMinute > 0 && Number.isInteger(value?.spendCentsPerDay) && value.spendCentsPerDay > 0) return { requestsPerMinute: value.requestsPerMinute, spendCentsPerDay: value.spendCentsPerDay };
  } catch {}
  return null;
}

const sanitize = text => String(text || '').replace(/[A-Za-z0-9_-]{32,}/g, '[withheld]').replace(/\s+/g, ' ').slice(0, 200);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// AI Gateway analytics over GraphQL with the Account Analytics Read token. The dataset and fields are not verified live, so any
// unexpected answer is degraded with its reason; nothing is ever reported as zero on failure.
export async function gatewayAnalytics(env, providerFetch = fetch, recentCalls = 0) {
  const end = new Date(), start = new Date(end.getTime() - day), window = { start: start.toISOString(), end: end.toISOString() };
  if (!env.EVIDENCE_GATEWAY) return { state: 'unavailable', reason: 'No AI Gateway is configured on this installation.', window };
  if (!env.OPERATIONS_ANALYTICS_TOKEN?.get) return { state: 'unavailable', reason: 'No Account Analytics Read token is bound (enable-analytics). Golf’s own ledger is shown instead.', window };
  try {
    if (!/^[a-f0-9]{32}$/.test(env.ACCOUNT_ID || '')) throw Error('The Cloudflare account ID is not configured.');
    const token = await env.OPERATIONS_ANALYTICS_TOKEN.get();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw Error('The analytics credential is unavailable.');
    const query = `query GolfAiGateway($accountTag: string, $start: string, $end: string, $gateway: string) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        aiGatewayRequestsAdaptiveGroups(limit: 50, filter: {datetime_geq: $start, datetime_leq: $end, gateway: $gateway}) {
          count sum { cost uncachedTokensIn uncachedTokensOut cachedTokensIn cachedTokensOut erroredRequests } dimensions { model }
        }
      } }
    }`;
    const response = await providerFetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { accountTag: env.ACCOUNT_ID, ...window, gateway: env.EVIDENCE_GATEWAY } }) });
    if (!response.headers.get('Content-Type')?.startsWith('application/json')) throw Error(`The analytics API answered ${response.status} without JSON.`);
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(response.body, 64 * 1024)));
    if (Array.isArray(data?.errors) && data.errors.length) throw Error('The analytics API refused the query: ' + sanitize(data.errors[0]?.message));
    if (!response.ok) throw Error(`The analytics API answered ${response.status}.`);
    const accounts = data?.data?.viewer?.accounts, rows = accounts?.[0]?.aiGatewayRequestsAdaptiveGroups;
    if (!Array.isArray(accounts) || accounts.length !== 1 || !Array.isArray(rows) || rows.length >= 50) throw Error('The analytics answer had an unexpected shape.');
    const keys = ['cost', 'uncachedTokensIn', 'uncachedTokensOut', 'cachedTokensIn', 'cachedTokensOut', 'erroredRequests'];
    if (rows.some(row => !Number.isSafeInteger(row?.count) || row.count < 0 || !keys.every(key => finite(row.sum?.[key])) || typeof (row.dimensions?.model ?? '') !== 'string')) throw Error('The analytics answer had an unexpected shape.');
    // An empty dataset while Golf recorded calls in the same window is not evidence of zero use.
    if (!rows.length && recentCalls) throw Error(`The gateway dataset returned no rows although Golf recorded ${recentCalls} calls in the last 24 hours.`);
    const total = key => rows.reduce((sum, row) => sum + row.sum[key], 0);
    return { state: 'observed', reason: '', window, requests: rows.reduce((sum, row) => sum + row.count, 0), errors: total('erroredRequests'), cost: Math.round(total('cost') * 1e6) / 1e6,
      tokensIn: total('uncachedTokensIn') + total('cachedTokensIn'), tokensOut: total('uncachedTokensOut') + total('cachedTokensOut'),
      models: rows.map(row => ({ model: String(row.dimensions?.model || 'Unreported').slice(0, 120), requests: row.count, cost: Math.round(row.sum.cost * 1e6) / 1e6, errors: row.sum.erroredRequests })) };
  } catch (error) { return { state: 'degraded', reason: sanitize(error?.name === 'TimeoutError' ? 'The analytics API did not answer within 5 seconds.' : error?.message) || 'Gateway analytics could not be read.', window }; }
}

// `/native/ai-usage/read` { action: 'read', days? }: operations administrators only, checked before and after the reads.
export async function aiUsageAPI(db, env, person, request, body, providerFetch = fetch) {
  const requireAdmin = async () => { if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.'); };
  await requireAdmin();
  if (body.action !== 'read') invalid('Use the read action.');
  const days = body.days === undefined ? 14 : body.days;
  if (!Number.isInteger(days) || days < 1 || days > 30) invalid('Read 1 to 30 days.');
  const now = Date.now(), since = new Date(now - (days - 1) * day).toISOString().slice(0, 10), today = new Date(now).toISOString().slice(0, 10);
  const { rows, unreadable } = await ledger(db, since);
  let todayRuns = null, recentCalls = 0;
  try { todayRuns = (await db.prepare('SELECT count(*) AS n FROM ai_runs WHERE created_at>=?').bind(today).first()).n; } catch {}
  try {
    const recent = new Date(now - day).toISOString();
    recentCalls = (await db.prepare("SELECT (SELECT count(*) FROM ai_runs WHERE created_at>=? AND infer_started_at IS NOT NULL)+(SELECT count(*) FROM evidence_jobs WHERE created_at>=? AND advice_state IN ('SUCCEEDED','UNKNOWN')) AS n").bind(recent, recent).first()).n;
  } catch {}
  const gateway = await gatewayAnalytics(env, providerFetch, recentCalls);
  await requireAdmin();
  return reply({ generatedAt: new Date(now).toISOString(), days, since, today, allocated: aiAllocation(env),
    limit: { daily: aiDailyLimit(env), todayRuns, source: env.AI_DAILY_LIMIT === undefined ? 'default' : 'deploy' },
    rows, unreadable, caps: limits(env), gateway: { ...gateway, gateway: env.EVIDENCE_GATEWAY || '' } });
}
