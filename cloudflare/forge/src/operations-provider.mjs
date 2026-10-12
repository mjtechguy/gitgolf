import { bounded } from './git.mjs';

export function operationsPolicy(settings) {
  const value = settings.operations;
  if (value === undefined) return { observability: { enabled: false } };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['analytics_secret','observability','service_health'].includes(key))) throw Error('Invalid operations configuration');
  const result = { observability: { enabled: false } };
  if (value.service_health !== undefined) { if (typeof value.service_health !== 'boolean') throw Error('Use an explicit service health policy'); result.serviceHealth = value.service_health; }
  if (value.analytics_secret !== undefined) {
    const secret = value.analytics_secret;
    if (!secret || Object.keys(secret).some(key => !['store','name'].includes(key)) || !/^[a-f0-9]{32}$/.test(secret.store) || !/^[A-Za-z0-9_-]{1,64}$/.test(secret.name)) throw Error('Use an approved Analytics Read secret reference');
    result.analyticsSecret = { store: secret.store, name: secret.name };
  }
  if (value.observability !== undefined) {
    const obs = value.observability;
    if (!obs || Object.keys(obs).some(key => !['enabled','sampling'].includes(key)) || typeof obs.enabled !== 'boolean' || typeof obs.sampling !== 'number' || !Number.isFinite(obs.sampling) || obs.sampling < 0 || obs.sampling > 0.1) throw Error('Use explicit observability sampling between 0 and 0.1');
    result.observability = { enabled: obs.enabled, headSamplingRate: obs.sampling, redactQueryString: true, logs: { enabled: obs.enabled, invocationLogs: false, headSamplingRate: obs.sampling }, traces: { enabled: false } };
  }
  return result;
}

export async function collectWorkerMetrics(env, providerFetch = fetch) {
  if (!env.OPERATIONS_ANALYTICS_TOKEN) return;
  const db = env.DB.withSession('first-primary'), stamp = new Date().toISOString();
  // Provider ingestion may lag; the retained window ends five minutes ago.
  const end = new Date(Date.now() - 5 * 60_000).toISOString(), start = new Date(Date.parse(end) - 30 * 60_000).toISOString();
  const reserved = await db.prepare("INSERT INTO operations_provider(service,attempted_at,state) VALUES('workers',?,'running') ON CONFLICT(service) DO UPDATE SET attempted_at=excluded.attempted_at,state='running' WHERE operations_provider.attempted_at<=?").bind(stamp,new Date(Date.now()-10*60_000).toISOString()).run();
  if (!reserved.meta.changes) return;
  try {
    if (!/^[a-f0-9]{32}$/.test(env.ACCOUNT_ID) || !/^[a-z0-9-]{3,63}$/.test(env.OPERATIONS_WORKER)) throw Error('Allocation unavailable');
    const token = await env.OPERATIONS_ANALYTICS_TOKEN.get();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw Error('Analytics credential unavailable');
    const query = `query GolfWorkerUsage($accountTag: string, $start: string, $end: string, $scriptName: string) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        workersInvocationsAdaptive(limit: 2, filter: {scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end}) {
          dimensions { scriptName } sum { requests errors subrequests }
        }
      } }
    }`;
    const response = await providerFetch('https://api.cloudflare.com/client/v4/graphql', { method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({query,variables:{accountTag:env.ACCOUNT_ID,start,end,scriptName:env.OPERATIONS_WORKER}}) });
    if (!response.ok || !response.headers.get('Content-Type')?.startsWith('application/json')) throw Error('Analytics observation unavailable');
    const data = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(response.body,64*1024)));
    const accounts = data?.data?.viewer?.accounts;
    if (data.errors != null && (!Array.isArray(data.errors) || data.errors.length) || !Array.isArray(accounts) || accounts.length !== 1) throw Error('Analytics observation unavailable');
    const rows = accounts[0].workersInvocationsAdaptive;
    // Empty datasets are not proof of zero traffic, and grouped rows must not be truncated.
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].dimensions?.scriptName !== env.OPERATIONS_WORKER) throw Error('Analytics observation unavailable');
    const sum = rows[0].sum;
    if (!sum || !['requests','errors','subrequests'].every(key => Number.isSafeInteger(sum[key]) && sum[key] >= 0) || sum.errors > sum.requests) throw Error('Analytics observation unavailable');
    await db.prepare("UPDATE operations_provider SET observed_at=?,window_start=?,window_end=?,state='succeeded',requests=?,errors=?,subrequests=? WHERE service='workers' AND attempted_at=?").bind(stamp,start,end,sum.requests,sum.errors,sum.subrequests,stamp).run();
  } catch {
    await db.prepare("UPDATE operations_provider SET state='failed' WHERE service='workers' AND attempted_at=?").bind(stamp).run();
    throw Error('Worker analytics collection failed. Last successful observations are retained.');
  }
}


export async function collectServiceHealth(env) {
  if (env.OPERATIONS_SERVICE_HEALTH !== 'true') return;
  const db=env.DB.withSession('first-primary');let failures=0;
  for(const [service,enabled] of [['artifacts',Boolean(env.ARTIFACTS)],['r2',Boolean(env.EVIDENCE_BUCKET)]]) {
    if(!enabled) continue;
    const stamp=new Date().toISOString();
    const reserved=await db.prepare("INSERT INTO operations_provider(service,attempted_at,state) VALUES(?,?,'running') ON CONFLICT(service) DO UPDATE SET attempted_at=excluded.attempted_at,state='running' WHERE operations_provider.attempted_at<=?").bind(service,stamp,new Date(Date.now()-10*60_000).toISOString()).run();
    if(!reserved.meta.changes) continue;
    try {
      if(service==='r2') await env.EVIDENCE_BUCKET.head('operations/read-health-probe');
      else {
        const row=await db.prepare("SELECT artifact_name FROM repositories WHERE state='ACTIVE' ORDER BY id LIMIT 1").first();
        if(!row) {await db.prepare("DELETE FROM operations_provider WHERE service=? AND attempted_at=? AND observed_at IS NULL").bind(service,stamp).run();continue;}
        const repo=await env.ARTIFACTS.get(row.artifact_name);
        try {const info=await repo.info();if(info.name!==row.artifact_name || info.remote!==`https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.ARTIFACTS_NAMESPACE}/${row.artifact_name}.git`)throw Error('Allocation changed');}finally{repo[Symbol.dispose]();}
      }
      await db.prepare("UPDATE operations_provider SET observed_at=?,state='succeeded' WHERE service=? AND attempted_at=?").bind(stamp,service,stamp).run();
    } catch {failures++;await db.prepare("UPDATE operations_provider SET state='failed' WHERE service=? AND attempted_at=?").bind(service,stamp).run();}
  }
  if(failures)throw Error('Some service health probes failed. Inspect retained observations.');
}
