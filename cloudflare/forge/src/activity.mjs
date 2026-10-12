import { BinaryReader, BinaryWriter } from '../../../web/node_modules/@bufbuild/protobuf/dist/esm/wire/index.js';
import { bounded } from './git.mjs';
import { Fault, invalid } from './common.mjs';

export const activityPath = '/rpc/golf.v1.RepositoryActivityService/WatchRepository';
export const activityTopics = ['source', 'issues', 'pulls', 'actions', 'agents'];
const bytes = value => new TextEncoder().encode(JSON.stringify(value));
export function activityFrame(value, binary = false, end = false) {
  let payload;
  if (binary && !end) {
    const writer = new BinaryWriter();
    for (const [field, name] of [[1, 'repositoryId'], [2, 'cursor'], [3, 'kind']]) writer.tag(field, 2).string(value[name]);
    for (const topic of value.topics) writer.tag(4, 2).string(topic);
    payload = writer.finish();
  } else payload = bytes(value);
  const frame = new Uint8Array(5 + payload.length); frame[0] = end ? 2 : 0;
  new DataView(frame.buffer).setUint32(1, payload.length); frame.set(payload, 5); return frame;
}
export async function activityInput(request) {
  const url = new URL(request.url), type = request.headers.get('Content-Type')?.split(';')[0];
  if (request.method !== 'POST' || url.search || !['application/connect+json', 'application/connect+proto'].includes(type)) invalid('Use a Connect repository stream POST.');
  let value;
  try {
    const frame = await bounded(request.body, 8192);
    if (frame.length < 5 || frame[0] !== 0 || new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1) !== frame.length - 5) throw Error('frame');
    if (type.endsWith('+json')) value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(5)));
    else {
      value = { repository: {}, repositoryId: '', cursor: '' };
      const reader = new BinaryReader(frame.subarray(5));
      while (reader.pos < reader.len) {
        const [field, wire] = reader.tag();
        if (field === 1 && wire === 2) {
          const key = new BinaryReader(reader.bytes());
          while (key.pos < key.len) { const [number, format] = key.tag(); if (format === 2 && [1, 2].includes(number)) value.repository[number === 1 ? 'owner' : 'name'] = key.string(); else key.skip(format, number); }
        } else if ([2, 3].includes(field) && wire === 2) value[field === 2 ? 'repositoryId' : 'cursor'] = reader.string();
        else reader.skip(wire, field);
      }
    }
  } catch { invalid('Invalid bounded Connect stream request.'); }
  if (!value || typeof value.repositoryId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.repositoryId) ||
      !value.repository || typeof value.repository.owner !== 'string' || typeof value.repository.name !== 'string' ||
      typeof (value.cursor ?? '') !== 'string' || !/^(?:0|[1-9][0-9]{0,18})?$/.test(value.cursor ?? '') || BigInt(value.cursor || 0) > 9223372036854775807n) invalid('Select an exact repository identity and valid cursor.');
  return { ...value, cursor: value.cursor || '', binary: type.endsWith('+proto'), type };
}

// Metadata-only journal: bounded history, no bodies, paths, identities or credentials.
export class RepositoryActivity {
  constructor(storage, authorize, options = {}) {
    this.storage = storage; this.authorize = authorize; this.listeners = new Map(); this.users = new Map(); this.total = 0;
    // Match the portable rotation so already-open older clients keep working.
    this.heartbeat = options.heartbeat ?? 5000; this.duration = options.duration ?? 10000;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS repository_activity(id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL, topics TEXT NOT NULL)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS repository_activity_scope ON repository_activity(repository_id,id)');
  }
  publish(repositoryId, topics) {
    if (!/^[1-9][0-9]*$/.test(repositoryId) || !topics.length || topics.some(topic => !activityTopics.includes(topic))) throw Error('Invalid activity publication');
    this.storage.transactionSync(() => {
      this.storage.sql.exec('INSERT INTO repository_activity(repository_id,topics) VALUES(?,?)', repositoryId, JSON.stringify([...new Set(topics)]));
      // Keep one watermark per canonical repository when older history is compacted.
      this.storage.sql.exec('DELETE FROM repository_activity WHERE id < (SELECT COALESCE(max(id),0)-1023 FROM repository_activity) AND id NOT IN (SELECT max(id) FROM repository_activity GROUP BY repository_id)');
    });
    for (const wake of this.listeners.get(repositoryId) || []) wake();
  }
  observation(repositoryId, cursor) {
    const rows = [...this.storage.sql.exec('SELECT id,topics FROM repository_activity WHERE repository_id=? ORDER BY id', repositoryId)];
    const max = [...this.storage.sql.exec('SELECT COALESCE(max(id),0) AS id FROM repository_activity')][0].id;
    if (cursor && BigInt(cursor) > BigInt(max)) invalid('Activity cursor is ahead of this workspace.');
    const owned = cursor && [...this.storage.sql.exec('SELECT repository_id FROM repository_activity WHERE id=?', cursor)][0];
    if (owned && owned.repository_id !== repositoryId) invalid('Activity cursor belongs to another repository.');
    if (cursor && BigInt(cursor) > BigInt(rows.at(-1)?.id || 0)) invalid('Activity cursor is ahead of this repository.');
    const reset = cursor === '' || cursor !== '0' && !owned;
    const changes = reset ? [] : rows.filter(row => BigInt(row.id) > BigInt(cursor));
    // A repository without events uses zero; it never borrows another repository's cursor.
    return { repositoryId, cursor: String(rows.at(-1)?.id || 0), kind: reset ? 'reset' : changes.length ? 'change' : 'heartbeat',
      topics: [...new Set(changes.flatMap(row => JSON.parse(row.topics)))] };
  }
  async watch(request) {
    const input = await activityInput(request), userId = await this.authorize(request, input);
    if (this.total >= 32 || (this.users.get(userId) || 0) >= 4) throw new Fault('resource_exhausted', 429, 'Close another live repository tab.');
    // Validate resume before allocating a connection.
    this.observation(input.repositoryId, input.cursor);
    this.total++; this.users.set(userId, (this.users.get(userId) || 0) + 1);
    let closed = false, first = true, ending = false, cursor = input.cursor, wake, timer, lease, streamController;
    const started = Date.now(), listeners = this.listeners.get(input.repositoryId) || new Set();
    this.listeners.set(input.repositoryId, listeners);
    const cleanup = () => {
      if (closed) return; closed = true; clearTimeout(timer); clearTimeout(lease); wake?.();
      if (wake) listeners.delete(wake); if (!listeners.size) this.listeners.delete(input.repositoryId);
      this.total--; const remaining = this.users.get(userId) - 1;
      if (remaining) this.users.set(userId, remaining); else this.users.delete(userId);
      request.signal.removeEventListener('abort', cleanup);
      if (request.signal.aborted && streamController) { try { streamController.close(); } catch {} }
    };
    request.signal.addEventListener('abort', cleanup, { once: true });
    const activity = this;
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
        lease = setTimeout(() => {
          if (closed) return;
          controller.enqueue(activityFrame({ error: { code: 'deadline_exceeded', message: 'Reconnect the live repository stream.' } }, input.binary, true));
          controller.close(); cleanup();
        }, activity.duration + activity.heartbeat);
      },
      async pull(controller) {
        if (closed) { try { controller.close(); } catch {} return; }
        if (ending) { controller.enqueue(activityFrame({}, input.binary, true)); controller.close(); cleanup(); return; }
        try {
          if (!first) await new Promise(resolve => {
            wake = resolve; listeners.add(wake); timer = setTimeout(wake, activity.heartbeat);
            // Close the race between observing the journal and subscribing.
            if (activity.observation(input.repositoryId, cursor).kind === 'change') wake();
          });
          clearTimeout(timer); if (wake) listeners.delete(wake);
          if (closed) { try { controller.close(); } catch {} return; }
          if (await activity.authorize(request, input) !== userId) throw new Fault('unauthenticated', 401, 'Sign-in required.');
          if (closed) return;
          const event = activity.observation(input.repositoryId, cursor); cursor = event.cursor; first = false;
          if (Date.now() - started >= activity.duration && event.kind !== 'change') { event.kind = 'reconnect'; ending = true; }
          controller.enqueue(activityFrame(event, input.binary));
        } catch (error) {
          if (closed) return;
          const code = error instanceof Fault ? error.code : 'unavailable';
          controller.enqueue(activityFrame({ error: { code, message: code === 'not_found' ? 'Repository unavailable.' : 'Repository live connection ended.' } }, input.binary, true));
          controller.close(); cleanup();
        }
      },
      cancel: cleanup,
    }, { highWaterMark: 0 });
    if (request.signal.aborted) { cleanup(); streamController.close(); }
    return new Response(body, { headers: { 'Content-Type': input.type, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } });
  }
}

export async function activitySelection(event) {
  if (!(event instanceof Request)) {
    if (event.preview || event.activity) return;
    if (event.notify) return { id: event.repositoryId, topics: event.topics || ['actions', 'agents', 'pulls'] };
    return { job: event.id, topics: ['actions', 'agents', 'pulls'] };
  }
  const path = new URL(event.url).pathname;
  const git = /^\/git\/[^/]+\/([^/]+)\.git\/git-receive-pack$/.exec(path);
  if (event.method !== 'POST') return;
  if (git) return { name: git[1], topics: ['source', 'pulls', 'actions'] };
  if (!/\/(?:CreateRepository|SetRepositoryStar|SetRepositoryCollaborator|RemoveRepositoryCollaborator|CreateRepositoryInvitation|RevokeRepositoryInvitation|RespondRepositoryInvitation|UpdateRepositorySettings|UpdateRepositoryTopics|SubmitDiscussionResourceOperation|CreateIssue|UpdateIssue|CreateIssueComment|CreatePullRequest|UpdatePullRequest|CreatePullRequestReview|SubmitPullReviewRequest|SubmitPullReviewLifecycle|SubmitPullReviewAuthoringOperation|ReportCheck)$/.test(path) &&
      !['/native/repository-grant', '/native/repository-check', '/native/pr-evidence', '/native/pr-preview'].includes(path)) return;
  let body;
  try { body = JSON.parse(new TextDecoder().decode(await bounded(event.clone().body, 96 * 1024))); } catch { return; }
  if (path.endsWith('/SubmitPullReviewAuthoringOperation') && ![4, 'PULL_REVIEW_AUTHORING_KIND_SUBMIT_DRAFT'].includes(body.kind)) return;
  if (['/native/pr-evidence', '/native/pr-preview'].includes(path) && ['list', 'get', 'grant', 'status', 'report', 'compare', 'screenshot'].includes(body.action)) return;
  return { name: body.repository?.name || body.selection?.repository?.name || body.target?.repository?.name || (path.endsWith('/CreateRepository') ? body.name : undefined),
    id: body.repositoryId || body.selection?.repositoryId || body.target?.repositoryId,
    ...(path.endsWith('/RespondRepositoryInvitation') ? { invitation: body.invitationId } : {}),
    topics: path.endsWith('/UpdateRepositorySettings') ? ['source','issues','pulls'] : path.endsWith('/SubmitDiscussionResourceOperation') ? ['issues', 'pulls'] : path.includes('Issue') ? [body.pullRequest ? 'pulls' : 'issues'] : path.includes('PullRequest') || path.includes('PullReview') || path.endsWith('repository-check') ? ['pulls'] :
      path.endsWith('repository-grant') || /\/(?:(?:Set|Remove)RepositoryCollaborator|(?:Create|Revoke|Respond)RepositoryInvitation)$/.test(path) ? activityTopics : path.endsWith('pr-preview') || path.endsWith('pr-evidence') ? ['actions', 'agents', 'pulls'] : ['issues'] };
}
