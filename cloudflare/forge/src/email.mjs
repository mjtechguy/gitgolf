import { digest, deny, invalid, Fault, page, uuidOK } from './common.mjs';
import { ownerJoin, ownerSlug } from './owners.mjs';

// The recipient is the caller's own Access sign-in address, so SMTP transports and mailbox verification codes are not served here.
export const emailMethods = new Set(['GetOwnEmailNotifications', 'SaveOwnEmailPreference', 'GetRepositoryEmailSubscription', 'SaveRepositoryEmailSubscription', 'ListOwnEmailDeliveries', 'RedeliverOwnEmail']);
const now = () => new Date().toISOString();
const stale = () => { throw new Fault('failed_precondition', 412, 'Email preferences or authority changed. Refresh before editing.'); };
const versionOK = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(value);
// One plain mailbox: no display names, lists, comments or quoting can reach a recipient field.
const addressOK = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
export function emailPolicy(env) {
  try {
    const p = JSON.parse(env.EMAIL_POLICY || 'null');
    // Without Access sign-in nobody can prove a mailbox, so the binding alone does not enable anything.
    if (!p || Object.keys(p).some(key => !['sender', 'dailyLimit'].includes(key)) || !addressOK(p.sender) || p.sender !== p.sender.toLowerCase() ||
        !Number.isInteger(p.dailyLimit) || p.dailyLimit < 1 || p.dailyLimit > 5000 || !env.EMAIL?.send || !env.ACCESS_AUD) return null;
    return p;
  } catch { return null; }
}
export function emailBindings(settings) {
  if (!settings.email) return {};
  if (!emailPolicy({ EMAIL_POLICY: JSON.stringify(settings.email), EMAIL: { send() {} }, ACCESS_AUD: settings.access_aud })) throw Error('Invalid native email policy, or Access sign-in is not configured');
  // The binding itself refuses any other sender; recipients are bounded by the Worker, not the binding.
  return { EMAIL_POLICY: { type: 'text', value: JSON.stringify(settings.email) }, EMAIL: { type: 'send-email', allowedSenderAddresses: [settings.email.sender] } };
}
// READY needs a recorded provider acceptance for the current sender; configuration alone stays DEGRADED.
export async function emailCapability(db, env) {
  const policy = emailPolicy(env), id = 'repository.email-notifications', label = 'Repository email notifications';
  if (!policy) return { id, label, state: 'CAPABILITY_STATE_DISABLED', reason: 'Configure a Cloudflare Email Service sending address, a daily limit and Cloudflare Access sign-in.' };
  let accepted;
  try { accepted = await db.prepare('SELECT accepted_at FROM email_acceptance WHERE sender=?').bind(policy.sender).first(); }
  catch { return { id, label, state: 'CAPABILITY_STATE_DISABLED', reason: 'The email notification schema is not applied on this installation.' }; }
  return { id, label, state: accepted ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DEGRADED',
    reason: `Email to each subscriber's own Access sign-in address through Cloudflare Email Service from ${policy.sender}. Messages name the repository and activity category with a sign-in link; no titles, bodies, source or logs. Provider acceptance is recorded; delivery, bounces and replies are not observed. At most ${policy.dailyLimit} send attempts per day.` +
      (accepted ? ` The provider first accepted a message from this sender on ${accepted.accepted_at.slice(0, 10)}.` : ' The provider has not yet accepted a message from this sender on this installation.') };
}

// Current account, own address, consent and repository grant, all at the versions the subscription was saved under.
const authority = `EXISTS(SELECT 1 FROM users u JOIN grants g ON g.user_id=u.id JOIN repositories r ON r.id=g.repository_id
 JOIN email_preferences p ON p.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
 LEFT JOIN collaborator_versions c ON c.repository_id=r.id AND c.user_id=u.id
 WHERE u.id=s.user_id AND u.active=1 AND u.email=p.email AND p.enabled=1 AND p.suppression='' AND p.identity_version=s.identity_version
 AND r.id=s.repository_id AND r.state='ACTIVE' AND r.artifact_name=s.artifact_name
 AND COALESCE(v.version,0)=s.identity_version AND COALESCE(c.generation,0)=s.grant_generation)`;
const pending = "(SELECT COUNT(*) FROM email_deliveries p WHERE p.user_id=s.user_id AND p.state IN ('queued','retrying','sending'))<200";
const contact = version => String(version + 1);
async function ownState(db, person) {
  const p = await db.prepare('SELECT * FROM email_preferences WHERE user_id=?').bind(person.id).first();
  const current = p && p.email === person.email && p.identity_version === person.identity_version;
  return { userId: String(person.id), nativeUserId: String(person.id), contactVersion: contact(person.identity_version), loginEmail: person.email, verified: true,
    enabled: Boolean(current && p.enabled && !p.suppression), suppression: current ? p.suppression : '', transportActive: true, preferenceVersion: String(p?.version || 0) };
}
const wire = s => ({ id: s.id, version: String(s.version), eventTopics: JSON.parse(s.event_topics), enabled: Boolean(s.enabled && s.authorized),
  authorizationState: !s.enabled ? 'disabled' : s.authorized ? 'authorized' : 'authority_unavailable', contactVersion: contact(s.identity_version),
  updatedAt: s.updated_at, workflowNotifications: s.workflow_notifications });
// No SMTP status or transport identity exists on this path; acceptance is the provider's own receipt.
const delivery = d => ({ id: d.id, kind: 'activity', eventId: d.event_id, eventTopic: d.event_topic, state: d.state, attempts: d.attempts, failureCode: d.failure_code,
  possibleDuplicate: !!d.possible_duplicate, createdAt: d.created_at, nextAttemptAt: ['queued', 'retrying'].includes(d.state) ? d.next_attempt_at : '', completedAt: d.completed_at || '',
  subscriptionId: d.subscription_id, subscriptionVersion: String(d.subscription_version), contactVersion: contact(d.identity_version) });

export async function emailNotifications(db, env, person, row, request, method, body) {
  if (!emailPolicy(env)) throw new Fault('failed_precondition', 412, 'Email notifications are not configured on this installation.');
  // Only a runtime-verified Access sign-in proves the mailbox. Bearer and service-token callers neither read nor change email settings.
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !person.email || request.headers.get('X-Golf-Native-Access-Email') !== person.email)
    throw new Fault('permission_denied', 403, 'Sign in through Cloudflare Access to manage email notifications.');
  if (!addressOK(person.email)) throw new Fault('failed_precondition', 412, 'This sign-in address cannot receive notification email.');
  const self = 'EXISTS(SELECT 1 FROM users u LEFT JOIN native_identity_versions v ON v.user_id=u.id WHERE u.id=? AND u.active=1 AND u.email=? AND COALESCE(v.version,0)=?)';
  const selfValues = [person.id, person.email, person.identity_version], userId = String(person.id), time = now();
  if (method === 'GetOwnEmailNotifications') return { state: await ownState(db, person) };
  if (method === 'SaveOwnEmailPreference') {
    if (!versionOK(body.expectedContactVersion) || !versionOK(body.expectedPreferenceVersion) || body.enabled !== undefined && typeof body.enabled !== 'boolean') invalid('Provide the observed contact and preference versions.');
    if (body.enabled && body.authorizeBackground !== true) invalid('Explicitly authorize enabled background email.');
    if (body.expectedContactVersion !== contact(person.identity_version)) stale();
    const version = Number(body.expectedPreferenceVersion);
    // Saving again is the explicit act that lifts a provider suppression pause.
    const result = await db.prepare(`INSERT INTO email_preferences(user_id,version,enabled,email,identity_version,suppression,updated_at) SELECT ?,?,?,?,?,'',? WHERE ${self}
      AND (EXISTS(SELECT 1 FROM email_preferences WHERE user_id=? AND version=?) OR ?=0 AND NOT EXISTS(SELECT 1 FROM email_preferences WHERE user_id=?))
      ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,email=excluded.email,identity_version=excluded.identity_version,suppression='',updated_at=excluded.updated_at WHERE email_preferences.version=?`)
      .bind(person.id, version + 1, body.enabled ? 1 : 0, person.email, person.identity_version, time, ...selfValues, person.id, version, version, person.id, version).run();
    if (!result.meta.changes) stale();
    return { state: await ownState(db, person) };
  }
  // Account-level history holds verification mail only, and this installation sends none.
  if (method === 'ListOwnEmailDeliveries' && !body.target) { page(body); return { deliveries: [], page: { nextPage: 0 }, userId }; }
  if (method === 'RedeliverOwnEmail') {
    if (!uuidOK(body.deliveryId) || !uuidOK(body.operationId) || !versionOK(body.expectedContactVersion)) invalid('Use the original delivery, a new operation ID and the observed contact version.');
    const original = await db.prepare(`SELECT d.*,s.version,s.enabled,${authority} AS authorized,
      EXISTS(SELECT 1 FROM grants g JOIN repositories r ON r.id=g.repository_id WHERE g.user_id=d.user_id AND r.id=d.repository_id AND r.state='ACTIVE') AS readable
      FROM email_deliveries d JOIN email_subscriptions s ON s.id=d.subscription_id WHERE d.id=? AND d.user_id=?`).bind(body.deliveryId, person.id).first();
    // History and replay of a repository the caller can no longer read stay closed.
    if (!original?.readable) deny();
    const inputHash = await digest(JSON.stringify([method, person.id, body.deliveryId, body.expectedContactVersion]));
    const previous = await db.prepare('SELECT * FROM email_deliveries WHERE id=?').bind(body.operationId).first();
    if (previous) {
      if (previous.user_id !== person.id) deny();
      if (previous.input_hash !== inputHash) throw new Fault('already_exists', 409, 'Delivery operation ID belongs to another request.');
      return { delivery: delivery(previous), userId };
    }
    if (!['accepted', 'failed', 'cancelled', 'suppressed'].includes(original.state)) throw new Fault('failed_precondition', 412, 'Wait for the original delivery to finish before redelivering.');
    if (body.expectedContactVersion !== contact(person.identity_version) || !original.enabled || !original.authorized) stale();
    const result = await db.prepare(`INSERT INTO email_deliveries(id,subscription_id,subscription_version,user_id,repository_id,identity_version,event_id,event_topic,input_hash,possible_duplicate,next_attempt_at,created_at)
      SELECT ?,s.id,s.version,s.user_id,s.repository_id,s.identity_version,?,?,?,1,?,? FROM email_subscriptions s WHERE s.id=? AND s.user_id=? AND s.version=? AND s.enabled=1 AND ${authority} AND ${pending}`)
      .bind(body.operationId, original.event_id, original.event_topic, inputHash, time, time, original.subscription_id, person.id, original.version).run();
    if (!result.meta.changes) {
      if ((await db.prepare("SELECT COUNT(*) AS n FROM email_deliveries WHERE user_id=? AND state IN ('queued','retrying','sending')").bind(person.id).first()).n >= 200) throw new Fault('resource_exhausted', 429, 'Too many messages are already waiting for this account.');
      stale();
    }
    return { delivery: delivery(await db.prepare('SELECT * FROM email_deliveries WHERE id=?').bind(body.operationId).first()), userId };
  }
  // A subscription needs the caller's own grant; a public repository's anonymous read access is not consent to background mail.
  const target = body.target;
  if (!row || !['read', 'write', 'admin'].includes(row.role) || target?.repositoryId !== String(row.id) || target.ownerId !== String(row.workspace_id) || target.repository?.owner !== ownerSlug(row, env) || target.repository.name !== row.name) deny();
  const select = `SELECT s.*,${authority} AS authorized FROM email_subscriptions s WHERE s.user_id=? AND s.repository_id=?`;
  if (method === 'GetRepositoryEmailSubscription') {
    const s = await db.prepare(select).bind(person.id, row.id).first();
    return { target, ...(s ? { subscription: wire(s) } : {}), state: await ownState(db, person) };
  }
  if (method === 'ListOwnEmailDeliveries') {
    const paging = page(body);
    const { results } = await db.prepare('SELECT * FROM email_deliveries WHERE user_id=? AND repository_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').bind(person.id, row.id, paging.limit + 1, paging.offset).all();
    return { deliveries: results.slice(0, paging.limit).map(delivery), page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 }, userId, target };
  }
  if (method !== 'SaveRepositoryEmailSubscription' || !uuidOK(body.id) || !versionOK(body.expectedVersion) || !versionOK(body.expectedContactVersion)) invalid('Provide a subscription ID with the observed subscription and contact versions.');
  const topics = body.eventTopics;
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 4 || new Set(topics).size !== topics.length || topics.some(v => !['source', 'issues', 'pulls', 'actions'].includes(v))) invalid('Choose distinct repository change topics.');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean' || body.enabled && body.authorizeBackground !== true) invalid('Explicitly authorize enabled background delivery.');
  const modes = ['WORKFLOW_NOTIFICATION_MODE_UNSPECIFIED', 'WORKFLOW_NOTIFICATION_MODE_ACTIVITY', 'WORKFLOW_NOTIFICATION_MODE_COMPLETED', 'WORKFLOW_NOTIFICATION_MODE_FAILURES'];
  let mode = typeof body.workflowNotifications === 'string' ? modes.indexOf(body.workflowNotifications) : body.workflowNotifications ?? 0;
  if (!Number.isInteger(mode) || mode < 0 || mode > 3) invalid('Choose a supported workflow notification mode.');
  if (body.expectedContactVersion !== contact(person.identity_version)) stale();
  const current = await db.prepare(select).bind(person.id, row.id).first(), version = Number(body.expectedVersion), enabled = body.enabled ? 1 : 0;
  if (current ? current.id !== body.id || current.version !== version : version !== 0) stale();
  mode ||= current?.workflow_notifications || 1;
  if (enabled && !(await ownState(db, person)).enabled) throw new Fault('failed_precondition', 412, 'Enable notification email in your account settings before enabling a subscription.');
  // Admission is bounded per account, per repository and per installation; the consent and grant are rechecked in the write itself.
  const result = await db.prepare(`INSERT INTO email_subscriptions(id,user_id,repository_id,artifact_name,version,event_topics,workflow_notifications,enabled,identity_version,grant_generation,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,COALESCE((SELECT generation FROM collaborator_versions WHERE repository_id=? AND user_id=?),0),?,? WHERE ${self}
    AND EXISTS(SELECT 1 FROM grants g JOIN repositories r ON r.id=g.repository_id WHERE g.user_id=? AND r.id=? AND r.artifact_name=? AND r.state='ACTIVE')
    AND (?=0 OR EXISTS(SELECT 1 FROM email_preferences p WHERE p.user_id=? AND p.enabled=1 AND p.suppression='' AND p.email=? AND p.identity_version=?))
    AND (EXISTS(SELECT 1 FROM email_subscriptions WHERE id=? AND user_id=? AND repository_id=? AND version=?) OR (?=0 AND NOT EXISTS(SELECT 1 FROM email_subscriptions WHERE id=? OR user_id=? AND repository_id=?)
      AND (SELECT COUNT(*) FROM email_subscriptions WHERE user_id=?)<100 AND (SELECT COUNT(*) FROM email_subscriptions WHERE repository_id=?)<500 AND (SELECT COUNT(*) FROM email_subscriptions)<10000))
    ON CONFLICT(id) DO UPDATE SET version=excluded.version,event_topics=excluded.event_topics,workflow_notifications=excluded.workflow_notifications,enabled=excluded.enabled,identity_version=excluded.identity_version,grant_generation=excluded.grant_generation,updated_at=excluded.updated_at
      WHERE email_subscriptions.user_id=? AND email_subscriptions.repository_id=? AND email_subscriptions.version=?`)
    .bind(body.id, person.id, row.id, row.artifact_name, version + 1, JSON.stringify([...topics].sort()), mode, enabled, person.identity_version, row.id, person.id, time, time, ...selfValues,
      person.id, row.id, row.artifact_name, enabled, person.id, person.email, person.identity_version, body.id, person.id, row.id, version, version, body.id, person.id, row.id, person.id, row.id, person.id, row.id, version).run();
  if (!result.meta.changes) stale();
  return { target, subscription: wire(await db.prepare(select).bind(person.id, row.id).first()) };
}

const categories = { source: ['Code changed', ''], issues: ['Issues changed', '/issues'], pulls: ['Pull requests changed', '/pulls'], actions: ['Checks changed', '/actions'] };
// The whole message: a fixed category, the repository name and links behind sign-in. Never a title, body, author, branch, source or log.
// Cloudflare Email Service assigns Message-ID and Date itself, so the stable delivery identity travels in a custom header.
function emailMessage(env, sender, d) {
  const [label, path] = categories[d.event_topic], name = ownerSlug(d, env) + '/' + d.name, link = env.PUBLIC_ORIGIN + '/' + name;
  return { from: sender, to: d.email, subject: `[${name}] ${label}`, headers: { 'X-Golf-Delivery-ID': d.id },
    text: `${label} in ${name}.\n\nSign in to view: ${link}${path}\n\nYou subscribed to email about this repository. Change or stop it: ${link}/settings/webhooks\n` };
}
// Fixed outcome codes; provider messages are never stored. Only rate, quota and service errors are retried.
const refusals = { E_RATE_LIMIT_EXCEEDED: ['rate_limited', true], E_DAILY_LIMIT_EXCEEDED: ['provider_quota_exhausted', true], E_INTERNAL_SERVER_ERROR: ['provider_unavailable', true],
  E_RECIPIENT_SUPPRESSED: ['recipient_suppressed', false], E_RECIPIENT_NOT_ALLOWED: ['recipient_refused', false], E_DELIVERY_FAILED: ['delivery_refused', false],
  E_SENDER_NOT_VERIFIED: ['sender_unavailable', false], E_SENDER_DOMAIN_NOT_AVAILABLE: ['sender_unavailable', false] };

// shortcut: receipts remain in D1; add archive tombstones before sustained high-volume use.
export async function drainEmail(env) {
  const policy = emailPolicy(env);
  if (!policy || env.DEMO_STOP_AT && Date.parse(env.DEMO_STOP_AT) <= Date.now()) return { processed: 0 };
  const db = env.DB.withSession('first-primary'), time = now();
  // A lost result may already have been accepted by the provider; the retry is disclosed as a possible duplicate.
  await db.prepare(`UPDATE email_deliveries SET state=CASE WHEN attempts>=6 THEN 'failed' ELSE 'retrying' END,possible_duplicate=1,failure_code='transport_uncertain',completed_at=CASE WHEN attempts>=6 THEN ? ELSE NULL END,next_attempt_at=?,lease=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=?`).bind(time, time, time).run();
  const { results } = await db.prepare("SELECT id FROM email_deliveries WHERE state IN ('queued','retrying') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 8").bind(time).all();
  const live = `s.version=d.subscription_version AND s.enabled=1 AND ${authority}`;
  const read = `SELECT d.*,u.email,r.name,o.slug AS owner_slug,(${live}) AS authorized FROM email_deliveries d JOIN email_subscriptions s ON s.id=d.subscription_id JOIN users u ON u.id=d.user_id JOIN repositories r ON r.id=d.repository_id ${ownerJoin} WHERE d.id=?`;
  let processed = 0;
  for (const item of results) {
    const d = await db.prepare(read).bind(item.id).first();
    if (!d || !['queued', 'retrying'].includes(d.state)) continue;
    if (!d.authorized) { await db.prepare("UPDATE email_deliveries SET state='cancelled',failure_code='authority_changed',completed_at=? WHERE id=? AND state IN ('queued','retrying')").bind(now(), d.id).run(); continue; }
    if (!categories[d.event_topic] || !addressOK(d.email)) { await db.prepare("UPDATE email_deliveries SET state='failed',failure_code='message_unavailable',completed_at=? WHERE id=? AND state IN ('queued','retrying')").bind(now(), d.id).run(); continue; }
    const lease = crypto.randomUUID(), day = now().slice(0, 10), leaseUntil = new Date(Date.now() + 30000).toISOString();
    const due = `d.id=? AND d.state IN ('queued','retrying') AND d.next_attempt_at<=? AND EXISTS(SELECT 1 FROM email_subscriptions s WHERE s.id=d.subscription_id AND ${live})`, claimed = now();
    // One transaction: the budget is spent only for a delivery this drain can still claim, so overlapping drains waste none of it.
    const claim = await db.batch([
      db.prepare(`INSERT INTO email_daily(day,attempts) SELECT ?,1 WHERE EXISTS(SELECT 1 FROM email_deliveries d WHERE ${due}) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<?`).bind(day, d.id, claimed, policy.dailyLimit),
      db.prepare(`UPDATE email_deliveries AS d SET state='sending',attempts=attempts+1,lease=?,lease_until=? WHERE ${due} AND changes()=1`).bind(lease, leaseUntil, d.id, claimed),
    ]);
    if (!claim[1].meta.changes) continue;
    let messageId = '', failure = '', uncertain = false, retryable = false;
    // The address is read again under the lease, immediately before the provider call. Mail accepted after this point cannot be recalled.
    const current = await db.prepare(read + ' AND d.state=\'sending\' AND d.lease=? AND d.lease_until>?').bind(d.id, lease, now()).first();
    if (!current?.authorized || !addressOK(current.email)) { await db.prepare("UPDATE email_deliveries SET state='cancelled',failure_code='authority_changed',completed_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND state='sending'").bind(now(), d.id, lease).run(); continue; }
    let timer;
    try {
      const sent = await Promise.race([env.EMAIL.send(emailMessage(env, policy.sender, current)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('send timeout')), 15000); })]);
      // Acceptance is the provider's message identifier and nothing weaker.
      if (typeof sent?.messageId === 'string' && sent.messageId && sent.messageId.length <= 512) messageId = sent.messageId;
      else { failure = 'acceptance_unconfirmed'; uncertain = true; }
    } catch (error) {
      const code = typeof error?.code === 'string' && /^E_[A-Z_]{1,60}$/.test(error.code) ? error.code : '';
      [failure, retryable] = refusals[code] || (code ? ['provider_rejected', false] : ['transport_uncertain', true]);
      uncertain = !code || code === 'E_INTERNAL_SERVER_ERROR';
    } finally { clearTimeout(timer); }
    const retry = !messageId && retryable && d.attempts + 1 < 6, suppressed = failure === 'recipient_suppressed', finished = now();
    await db.batch([
      db.prepare(`UPDATE email_deliveries SET state=?,failure_code=?,possible_duplicate=MAX(possible_duplicate,?),sender=?,provider_message_id=?,next_attempt_at=?,completed_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND state='sending'`)
        .bind(messageId ? 'accepted' : retry ? 'retrying' : suppressed ? 'suppressed' : 'failed', failure, uncertain ? 1 : 0, policy.sender, messageId, new Date(Date.now() + Math.min(3600, 30 * 2 ** d.attempts) * 1000).toISOString(), retry ? null : finished, d.id, lease),
      ...(messageId ? [db.prepare('INSERT OR IGNORE INTO email_acceptance(sender,delivery_id,accepted_at) VALUES(?,?,?)').bind(policy.sender, d.id, finished)] : []),
      // A provider-suppressed mailbox pauses the account's mail until its owner explicitly saves the preference again.
      ...(suppressed ? [db.prepare("UPDATE email_preferences SET suppression='recipient_rejected' WHERE user_id=? AND email=?").bind(d.user_id, current.email)] : []),
    ]);
    processed++;
  }
  const waiting = (await db.prepare("SELECT COUNT(*) AS n FROM email_deliveries WHERE state IN ('queued','retrying','sending')").first()).n;
  return { processed, pending: waiting };
}
