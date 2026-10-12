import { digest, deny, invalid, Fault, page, uuidOK } from './common.mjs';

export const webhookMethods = new Set(['ListRepositoryWebhooks', 'SaveRepositoryWebhook', 'ListRepositoryWebhookDeliveries', 'TestRepositoryWebhook', 'RedeliverRepositoryWebhook']);
const text = new TextEncoder(), now = () => new Date().toISOString();
const stale = () => { throw new Fault('failed_precondition', 412, 'Webhook configuration or authority changed. Refresh before editing.'); };
const keyOK = value => typeof value === 'string' && /^[A-Za-z0-9_\-/+=]{32,128}$/.test(value);
const versionOK = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(value);
function publicURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s\p{Cc}]/u.test(value)) invalid('Use an approved HTTPS destination.');
  let url; try { url = new URL(value); } catch { invalid('Use an approved HTTPS destination.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.hostname.length > 253 ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/.test(url.hostname) || url.hostname.split('.').some(part => part.length > 63 || part.startsWith('-') || part.endsWith('-')) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname) || url.hostname.endsWith('.home.arpa')) invalid('Use a public HTTPS hostname without credentials, fragments or a custom port.');
  return url;
}
export function webhookPolicy(env) {
  try {
    const p = JSON.parse(env.WEBHOOK_POLICY || 'null');
    if (!p || Object.keys(p).some(key => !['origins', 'dailyLimit'].includes(key)) || !Array.isArray(p.origins) || p.origins.length < 1 || p.origins.length > 32 || new Set(p.origins).size !== p.origins.length ||
        !Number.isInteger(p.dailyLimit) || p.dailyLimit < 1 || p.dailyLimit > 5000 || !env.WEBHOOK_KEY?.get) return null;
    for (const origin of p.origins) if (publicURL(origin).origin !== origin || origin === env.PUBLIC_ORIGIN) return null;
    return p;
  } catch { return null; }
}
export function webhookBindings(settings) {
  if (!settings.webhooks) return {};
  const { key, ...policy } = settings.webhooks;
  if (!key || !/^[a-f0-9]{32}$/.test(key.store || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(key.name || '') || Object.keys(key).some(k => !['store','name'].includes(k)) ||
      !webhookPolicy({ PUBLIC_ORIGIN: settings.origin, WEBHOOK_POLICY: JSON.stringify(policy), WEBHOOK_KEY: { get() {} } })) throw Error('Invalid native webhook policy or Secrets Store binding');
  return { WEBHOOK_POLICY: { type:'text',value:JSON.stringify(policy) }, WEBHOOK_KEY: { type:'secrets-store-secret',storeId:key.store,secretName:key.name } };
}
function destination(env, endpoint) {
  const url = publicURL(endpoint), policy = webhookPolicy(env);
  // Exact operator-approved origins bound egress; subscription input cannot add destinations or private network bindings.
  if (!policy?.origins.includes(url.origin)) invalid('This webhook destination requires operator approval in the Cloudflare webhook policy.');
  return url;
}
const encode = bytes => btoa(String.fromCharCode(...bytes));
async function encryptionKey(env) {
  const value = await env.WEBHOOK_KEY.get();
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw Error('Webhook encryption key unavailable');
  return crypto.subtle.importKey('raw', Uint8Array.from(atob(value), c => c.charCodeAt(0)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const binding = (env, row, id, version) => text.encode(JSON.stringify(['golf.native.webhook.v1', env.PUBLIC_ORIGIN, row.id, row.artifact_name, id, version]));
async function seal(env, row, id, version, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: binding(env, row, id, version) }, await encryptionKey(env), text.encode(JSON.stringify(value)));
  return encode(iv) + '.' + encode(new Uint8Array(encrypted));
}
async function open(env, row, subscription) {
  const [iv, encrypted] = subscription.encrypted.split('.');
  const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: binding(env, row, subscription.id, subscription.credential_version) }, await encryptionKey(env), bytes(encrypted));
  const value = JSON.parse(new TextDecoder().decode(plain));
  if (!keyOK(value.signingSecret)) throw Error('Webhook credential unavailable');
  return value;
}
const sponsorAuthority = `EXISTS(SELECT 1 FROM users u JOIN grants g ON g.user_id=u.id
 JOIN repositories r ON r.id=g.repository_id LEFT JOIN native_identity_versions v ON v.user_id=u.id
 LEFT JOIN collaborator_versions c ON c.repository_id=r.id AND c.user_id=u.id
 WHERE u.id=s.sponsor_id AND u.active=1 AND g.role='admin' AND r.id=s.repository_id AND r.state='ACTIVE'
 AND r.artifact_name=s.artifact_name AND COALESCE(v.version,0)=s.identity_version AND COALESCE(c.generation,0)=s.grant_generation)`;
const subscriptionSelect = `SELECT s.*,${sponsorAuthority} AS authorized FROM webhook_subscriptions s`;
function actorGuard(person, row) {
  return { sql: `EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
    LEFT JOIN repository_access_versions a ON a.repository_id=r.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
    WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND g.role='admin' AND u.active=1
    AND COALESCE(a.version,0)=? AND COALESCE(v.version,0)=? AND (?='' OR EXISTS(SELECT 1 FROM credentials WHERE digest=? AND user_id=u.id AND revoked=0 AND expires_at>CAST(strftime('%s','now') AS INTEGER))))`,
    values: [row.id, row.artifact_name, person.id, row.access_version || 0, person.identity_version || 0, person.credential_digest || '', person.credential_digest || ''] };
}
const wire = s => ({ id: s.id, version: String(s.version), name: s.name, destinationHost: s.destination_host, eventTopics: JSON.parse(s.event_topics), enabled: !!s.enabled,
  authorizationState: !s.enabled ? 'disabled' : s.authorized ? 'authorized' : 'authority_unavailable', hasSigningSecret: true, sponsorUserId: String(s.sponsor_id),
  createdAt: s.created_at, updatedAt: s.updated_at, workflowNotifications: s.workflow_notifications });
const delivery = d => ({ id: d.id, subscriptionId: d.subscription_id, subscriptionVersion: String(d.subscription_version), eventId: d.event_id, eventTopic: d.event_topic,
  state: d.state, attempts: d.attempts, responseStatus: d.response_status, failureCode: d.failure_code, possibleDuplicate: !!d.possible_duplicate, createdAt: d.created_at,
  nextAttemptAt: ['queued','retrying'].includes(d.state) ? d.next_attempt_at : '', completedAt: d.completed_at || '' });
export async function repositoryWebhooks(db, env, person, row, method, body) {
  if (!webhookPolicy(env)) throw new Fault('failed_precondition', 412, 'Configure an encryption key and approved webhook destinations first.');
  const target = body.target;
  if (row.role !== 'admin' || target?.repositoryId !== String(row.id) || target.ownerId !== String(row.workspace_id) || target.repository?.owner !== env.WORKSPACE_SLUG || target.repository.name !== row.name) deny();
  const guard = actorGuard(person, row), paging = page(body);
  if (method === 'ListRepositoryWebhooks') {
    const { results } = await db.prepare(subscriptionSelect + ' WHERE s.repository_id=? ORDER BY s.id LIMIT ? OFFSET ?').bind(row.id, paging.limit + 1, paging.offset).all();
    return { target, subscriptions: results.slice(0,paging.limit).map(wire), page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 }, backgroundAuthorizationSupported: true };
  }
  if (method === 'SaveRepositoryWebhook') {
    if (!uuidOK(body.id) || !versionOK(body.expectedVersion) || typeof body.name !== 'string' || !body.name.trim() || body.name !== body.name.trim() || text.encode(body.name).length > 120 || /\p{Cc}/u.test(body.name)) invalid('Provide a subscription ID, saved version and name.');
    const topics = body.eventTopics;
    if (!Array.isArray(topics) || topics.length < 1 || topics.length > 4 || new Set(topics).size !== topics.length || topics.some(v => !['source','issues','pulls','actions'].includes(v))) invalid('Choose distinct repository change topics.');
    if (body.enabled && body.authorizeBackground !== true || body.enabled !== undefined && typeof body.enabled !== 'boolean') invalid('Explicitly authorize enabled background delivery.');
    const current = await db.prepare(subscriptionSelect + ' WHERE s.id=? AND s.repository_id=?').bind(body.id, row.id).first();
    const version = Number(body.expectedVersion);
    if (current ? current.version !== version : version !== 0) stale();
    const modes = ['WORKFLOW_NOTIFICATION_MODE_UNSPECIFIED','WORKFLOW_NOTIFICATION_MODE_ACTIVITY','WORKFLOW_NOTIFICATION_MODE_COMPLETED','WORKFLOW_NOTIFICATION_MODE_FAILURES'];
    let mode = typeof body.workflowNotifications === 'string' ? modes.indexOf(body.workflowNotifications) : body.workflowNotifications ?? 0;
    if (!Number.isInteger(mode) || mode < 0 || mode > 3) invalid('Choose a supported workflow notification mode.');
    mode ||= current?.workflow_notifications || 1;
    let encrypted, host, credentialVersion = version + 1;
    if (current && !body.enabled && !body.endpoint && !body.signingSecret) {
      encrypted = current.encrypted; host = current.destination_host; credentialVersion = current.credential_version;
    } else {
      const prior = current && (!body.endpoint || !body.signingSecret) ? await open(env, row, current) : {};
      const value = { endpoint: body.endpoint || prior.endpoint, signingSecret: body.signingSecret || prior.signingSecret };
      host = destination(env, value.endpoint).hostname;
      if (!keyOK(value.signingSecret)) invalid('Use a signing secret of 32–128 ASCII key characters.');
      encrypted = await seal(env, row, body.id, credentialVersion, value);
    }
    const time = now();
    const result = await db.prepare(`INSERT INTO webhook_subscriptions(id,repository_id,artifact_name,version,name,destination_host,encrypted,credential_version,event_topics,workflow_notifications,enabled,sponsor_id,identity_version,grant_generation,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT generation FROM collaborator_versions WHERE repository_id=? AND user_id=?),0),?,? WHERE ${guard.sql}
      AND (EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id=? AND repository_id=? AND version=?) OR (?=0 AND NOT EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id=?) AND (SELECT COUNT(*) FROM webhook_subscriptions WHERE repository_id=?)<20 AND (SELECT COUNT(*) FROM webhook_subscriptions)<5000))
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,name=excluded.name,destination_host=excluded.destination_host,encrypted=excluded.encrypted,credential_version=excluded.credential_version,event_topics=excluded.event_topics,workflow_notifications=excluded.workflow_notifications,enabled=excluded.enabled,sponsor_id=excluded.sponsor_id,identity_version=excluded.identity_version,grant_generation=excluded.grant_generation,updated_at=excluded.updated_at WHERE webhook_subscriptions.repository_id=? AND webhook_subscriptions.version=?`)
      .bind(body.id,row.id,row.artifact_name,version+1,body.name,host,encrypted,credentialVersion,JSON.stringify([...topics].sort()),mode,body.enabled?1:0,person.id,person.identity_version||0,row.id,person.id,time,time,...guard.values,body.id,row.id,version,version,body.id,row.id,row.id,version).run();
    if (!result.meta.changes) stale();
    return { target, subscription: wire(await db.prepare(subscriptionSelect + ' WHERE s.id=?').bind(body.id).first()) };
  }
  if (method === 'ListRepositoryWebhookDeliveries') {
    if (!uuidOK(body.subscriptionId)) invalid('Choose a webhook.');
    if (!await db.prepare('SELECT id FROM webhook_subscriptions WHERE id=? AND repository_id=?').bind(body.subscriptionId,row.id).first()) deny();
    const { results } = await db.prepare('SELECT * FROM webhook_deliveries WHERE subscription_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').bind(body.subscriptionId,paging.limit+1,paging.offset).all();
    return { target, deliveries: results.slice(0,paging.limit).map(delivery), page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } };
  }
  if (!['TestRepositoryWebhook','RedeliverRepositoryWebhook'].includes(method) || !uuidOK(body.operationId) || !versionOK(body.expectedVersion)) invalid('Use an original delivery operation ID and subscription version.');
  const redeliver = method === 'RedeliverRepositoryWebhook';
  if (!uuidOK(redeliver ? body.deliveryId : body.subscriptionId)) invalid('Choose a delivery or subscription.');
  const inputHash = await digest(JSON.stringify([method,person.id,row.id,body.subscriptionId||'',body.deliveryId||'',body.expectedVersion]));
  const previous = await db.prepare('SELECT d.*,s.repository_id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.id=?').bind(body.operationId).first();
  if (previous) {
    if (previous.repository_id !== row.id || previous.requested_by !== person.id) deny();
    if (previous.input_hash !== inputHash) throw new Fault('already_exists',409,'Delivery operation ID belongs to another request.');
    return { target, delivery: delivery(previous) };
  }
  const original = redeliver ? await db.prepare('SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.id=? AND s.repository_id=?').bind(body.deliveryId,row.id).first() : null;
  if (redeliver && !original) deny();
  if (original && !['accepted','failed','cancelled'].includes(original.state)) throw new Fault('failed_precondition',412,'Wait for the original delivery to finish before redelivering.');
  const id = original?.subscription_id || body.subscriptionId;
  const subscription = await db.prepare(subscriptionSelect + ' WHERE s.id=? AND s.repository_id=?').bind(id,row.id).first();
  if (!subscription) deny();
  if (String(subscription.version) !== body.expectedVersion || !subscription.enabled || !subscription.authorized) stale();
  const eventID = original?.event_id || 'test:' + body.operationId;
  const payload = original?.payload || JSON.stringify({ schema:'golf.webhook.v1',event:'golf.webhook.test',event_id:eventID });
  const time = now();
  const result = await db.prepare(`INSERT INTO webhook_deliveries(id,subscription_id,subscription_version,event_id,event_topic,payload,requested_by,input_hash,possible_duplicate,next_attempt_at,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND EXISTS(SELECT 1 FROM webhook_subscriptions s WHERE s.id=? AND s.version=? AND s.enabled=1 AND ${sponsorAuthority})`)
    .bind(body.operationId,id,subscription.version,eventID,original?.event_topic||'test',payload,person.id,inputHash,original?1:0,time,time,...guard.values,id,subscription.version).run();
  if (!result.meta.changes) stale();
  return { target, delivery: delivery(await db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').bind(body.operationId).first()) };
}

// shortcut: receipts remain in D1; add archive/idempotency tombstones before sustained high-volume use.
export async function drainWebhooks(env, options = {}) {
  const policy = webhookPolicy(env);
  if (!policy || env.DEMO_STOP_AT && Date.parse(env.DEMO_STOP_AT) <= Date.now()) return { processed: 0 };
  const db = env.DB.withSession('first-primary'), time = now();
  // A lost response may already have reached the receiver; retries preserve event/delivery IDs.
  await db.prepare(`UPDATE webhook_deliveries SET state=CASE WHEN attempts>=6 THEN 'failed' ELSE 'retrying' END,possible_duplicate=1,failure_code='transport_uncertain',completed_at=CASE WHEN attempts>=6 THEN ? ELSE NULL END,next_attempt_at=? WHERE state='sending' AND lease_until<=?`).bind(time,time,time).run();
  const { results } = await db.prepare("SELECT id FROM webhook_deliveries WHERE state IN ('queued','retrying') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 8").bind(time).all();
  let processed = 0;
  for (const item of results) {
    const d = await db.prepare(`SELECT d.*,s.repository_id,s.artifact_name,s.version,s.encrypted,s.credential_version,s.enabled,${sponsorAuthority} AS authorized FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.id=?`).bind(item.id).first();
    if (!d || !['queued','retrying'].includes(d.state)) continue;
    if (!d.enabled || !d.authorized || d.version !== d.subscription_version) {
      await db.prepare("UPDATE webhook_deliveries SET state='cancelled',failure_code='authority_changed',completed_at=? WHERE id=? AND state IN ('queued','retrying')").bind(now(),d.id).run(); continue;
    }
    let value;
    try { value = await open(env, {id:d.repository_id,artifact_name:d.artifact_name}, {id:d.subscription_id,credential_version:d.credential_version,encrypted:d.encrypted}); destination(env,value.endpoint); }
    catch { await db.prepare("UPDATE webhook_deliveries SET state='failed',failure_code='destination_or_credential_unavailable',completed_at=? WHERE id=? AND state IN ('queued','retrying')").bind(now(),d.id).run(); continue; }
    const lease = crypto.randomUUID(), day = now().slice(0,10), leaseUntil = new Date(Date.now()+30000).toISOString();
    const claim = await db.batch([
      db.prepare(`INSERT INTO webhook_daily(day,attempts) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<?`).bind(day,policy.dailyLimit),
      db.prepare(`UPDATE webhook_deliveries SET state='sending',attempts=attempts+1,lease=?,lease_until=? WHERE id=? AND state IN ('queued','retrying') AND next_attempt_at<=? AND changes()=1 AND EXISTS(SELECT 1 FROM webhook_subscriptions s WHERE s.id=subscription_id AND s.version=subscription_version AND s.enabled=1 AND ${sponsorAuthority})`).bind(lease,leaseUntil,d.id,now()),
    ]);
    if (!claim[1].meta.changes) continue;
    let status = 0, failure = '', uncertain = false, retryAfter = 0;
    try {
      const stamp = String(Math.floor(Date.now()/1000));
      const key = await crypto.subtle.importKey('raw',text.encode(value.signingSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const signed = await crypto.subtle.sign('HMAC',key,text.encode(stamp+'\n'+d.event_id+'\n'+d.payload));
      const signature = 'sha256='+[...new Uint8Array(signed)].map(b=>b.toString(16).padStart(2,'0')).join('');
      const beforeSend = await db.prepare(`SELECT d.id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.id=? AND d.state='sending' AND d.lease=? AND d.lease_until>? AND s.version=d.subscription_version AND s.enabled=1 AND ${sponsorAuthority}`).bind(d.id,lease,now()).first();
      if (!beforeSend) { await db.prepare("UPDATE webhook_deliveries SET state='cancelled',failure_code='authority_changed',completed_at=? WHERE id=? AND lease=? AND state='sending'").bind(now(),d.id,lease).run(); continue; }
      const response = await (options.fetch || fetch)(value.endpoint,{method:'POST',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','User-Agent':'Golf-Webhooks/1','X-Golf-Event-ID':d.event_id,'X-Golf-Delivery-ID':d.id,'X-Golf-Timestamp':stamp,'X-Golf-Signature-256':signature},body:d.payload});
      status = response.status;
      const delay = response.headers.get('Retry-After');
      if (delay && /^\d{1,5}$/.test(delay)) retryAfter = Math.min(Number(delay),3600);
      if (response.body) await response.body.cancel();
      if (status < 200 || status >= 300) failure = 'http_rejected';
    } catch { failure='transport_uncertain'; uncertain=true; }
    const accepted = status >= 200 && status < 300, retry = !accepted && d.attempts+1 < 6 && (uncertain || status===429 || status>=500);
    await db.prepare(`UPDATE webhook_deliveries SET state=?,response_status=?,failure_code=?,possible_duplicate=MAX(possible_duplicate,?),next_attempt_at=?,completed_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND state='sending'`)
      .bind(accepted?'accepted':retry?'retrying':'failed',status,failure,uncertain||status>=500?1:0,new Date(Date.now()+Math.max(retryAfter,Math.min(3600,30*2**d.attempts))*1000).toISOString(),retry?null:now(),d.id,lease).run();
    processed++;
  }
  const pending = (await db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE state IN ('queued','retrying','sending')").first()).n;
  return { processed, pending };
}
