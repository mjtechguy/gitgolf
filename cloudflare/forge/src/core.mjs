import { fileIndex } from './file-index.mjs';
import { pullCodeOwners } from './codeowners.mjs';
import { reviewAuthoring, reviewAuthoringMethods } from './review-authoring.mjs';
import { pullReviews, pullReviewMethods, pullMergeObservation } from './pull-reviews.mjs';
import { gitCredentialActor, confirmGitCredential, gitCredentialSQL, gitCredentials, gitCredentialMethods } from './git-credentials.mjs';
import { repositoryRules, enforceGitRules, ruleMethods } from './repository-rules.mjs';
import { repositoryWebhooks, webhookPolicy } from './webhooks.mjs';
import { engagement, engagementMethods } from './discussion-engagement.mjs';
import { resourceMethods, discussionResources, resourceOperation } from './discussion-resources.mjs';
import { invitations, ownInvitationMethods } from './invitations.mjs';
import { operationsAdmin, operationsDashboard } from './operations.mjs';
import { commits, resolveSource, wireCommit } from './repository-reads.mjs';
import { cachedRepository } from './repository-cache.mjs';
import { indexedRead } from './repository-indexes.mjs';
import { rootMetadata } from './repository-metadata.mjs';
import { timings, timedDatabase, timedResponse, release, configuration } from './telemetry.mjs';
import { repositoryImage } from './repository-images.mjs';
import { repositorySettings, repositoryCollaborators, repositoryPackages } from './repository-settings.mjs';
import { comparison, diff } from './repository-diff.mjs';
import { organizations, profile, stars } from './workspace-ui.mjs';
import { collaboration, collaborationMethods, operationRepository } from './collaboration.mjs';
import { evidenceAPI, evidenceStep, evidencePolicy } from './evidence.mjs';
import { agentPolicy } from './agent-policy.mjs';
import { executionDiagnostic, testPolicy } from './test-policy.mjs';
import { appPolicy } from './app-policy.mjs';
import { previewAPI, previewPolicy, previewRequest, cleanupPreviews } from './delivery.mjs';
import { digest, uuidOK, reply, Fault, deny, invalid, unsupported, conflict, page, user } from './common.mjs';
export { digest } from './common.mjs';
import { defaultBranchAdvertisement, advertisedRefs, bounded, gitRequest, receiveCommand, remote, sha, validRef, GitProviderError } from './git.mjs';

const jsonHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
export function serialize(handler, isRead = () => false) {
  const queue = []; let running = 0, writing = false;
  const drain = () => {
    if (writing) return;
    while (queue.length && running < 8) {
      const next = queue[0];
      if (!next.read && running) return;
      queue.shift(); running++; writing = !next.read;
      const delay = performance.now() - next.enqueued;
      Promise.resolve().then(() => handler(next.request)).then(value => next.resolve(value instanceof Response ? timedResponse(value, null, 'queue', delay) : value), next.reject).finally(() => { running--; writing = false; drain(); });
      if (writing) return;
    }
  };
  return request => new Promise((resolve, reject) => {
    if (queue.length >= 128) {
      const error = new Fault('resource_exhausted', 429, 'Workspace is busy. Retry with backoff.');
      if (request instanceof Request) resolve(new Response(JSON.stringify({ code: error.code, message: error.message }), { status: 429, headers: { ...jsonHeaders, 'Content-Type': 'application/json', 'Retry-After': '1' } }));
      else reject(error);
      return;
    }
    queue.push({ request, read: isRead(request), resolve, reject, enqueued: performance.now() }); drain();
  });
}
// Reads overlap; a queued mutation/revocation fences all subsequent admissions.
export function concurrentRead(request) {
  if (!(request instanceof Request) || request.method !== 'POST') return false;
  return /^\/rpc\/golf\.v1\.(SessionService\/GetSession|OperationsService\/GetOperationsDashboard|CapabilityService\/ListCapabilities|ProfileService\/GetProfile|OrganizationService\/(ListOrganizations|GetOrganization)|RepositorySettingsService\/GetRepositorySettings|RepositoryAccessService\/(GetRepositoryAccess|ListRepositoryCollaborators|ResolveRepositoryCollaborator|GetRepositoryAccessOperation)|RepositoryService\/(GetRepository|GetRepositoryOverview|GetRepositoryStar|ListRepositories|ListBranches|ListTags|ResolveRepositorySource|GetRepositoryFileIndex|GetContents|GetRepositoryImage|ListCommits|GetCommitDiff|GetRepositoryComparison|GetIssue|ListIssues|ListIssueComments|GetPullRequest|ListPullRequests|GetPullRequestDiscussion|ListPullRequestCommits|GetPullRequestDiff|ListPullRequestReviews|ListPullRequestChecks))$/.test(new URL(request.url).pathname);
}
const nameOK = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value) && !value.endsWith('.git');
async function input(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') invalid('Use JSON.');
  let bytes;
  try { bytes = await bounded(request.body, 96 * 1024); } catch (error) {
    if (error.message === 'payload limit') throw new Fault('resource_exhausted', 429, 'JSON request exceeds the native limit.');
    throw error;
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid('Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Use a request object.');
  return body;
}

async function actor(db, request) {
  const authorization = request.headers.get('Authorization') || '';
  if (authorization.startsWith('Basic ') || authorization.startsWith('Bearer golf_git_')) return gitCredentialActor(db,request);
  const match = /^Bearer (golf_native_[A-Za-z0-9_-]{43})$/.exec(authorization);
  // Access identity is populated only by the public Worker from runtime context.
  const email = request.headers.get('X-Golf-Native-Access-Email');
  let row;
  if (match) {
    row = await db.prepare(`SELECT c.digest AS credential_digest,u.id,u.login,u.email,u.active,u.can_create,COALESCE(v.version,0) AS identity_version,COALESCE(p.full_name,u.full_name) AS full_name FROM credentials c JOIN users u ON u.id=c.user_id LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
      WHERE c.digest=? AND c.expires_at>? AND c.revoked=0 AND u.active=1`).bind(await digest(match[1]), Math.floor(Date.now() / 1000)).first();
  } else if (!authorization && email) {
    row = await db.prepare('SELECT u.id,u.login,u.email,u.active,u.can_create,COALESCE(v.version,0) AS identity_version,COALESCE(p.full_name,u.full_name) AS full_name FROM users u LEFT JOIN profiles p ON p.user_id=u.id LEFT JOIN native_identity_versions v ON v.user_id=u.id WHERE u.email=? AND u.active=1').bind(email).first();
  }
  if (!row) throw new Fault('unauthenticated', 401, 'Sign-in required.');
  return row;
}

async function authorizedRepository(db, person, key, env, id) {
  if (key?.owner !== env.WORKSPACE_SLUG || !nameOK(key?.name)) deny();
  const row = await db.prepare(`SELECT r.*,g.role,w.id AS workspace_id,COALESCE(v.version,0) AS access_version,COALESCE(s.description,r.description) AS description FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN workspaces w ON w.slug=? AND w.artifact_namespace=? LEFT JOIN repository_settings s ON s.repository_id=r.id LEFT JOIN repository_access_versions v ON v.repository_id=r.id
    WHERE r.name=? AND g.user_id=? AND r.state='ACTIVE'`).bind(env.WORKSPACE_SLUG, env.ARTIFACTS_NAMESPACE, key.name, person.id).first();
  if (!row || id && String(row.id) !== id || person.git_repository_id && person.git_repository_id!==row.id) deny();
  return row;
}

export async function activityAuthority(request, env, input) {
  if (env.DEMO_STOP_AT && Date.parse(env.DEMO_STOP_AT) <= Date.now()) throw new Fault('unavailable', 503, 'Repository session ended.');
  const db = env.DB.withSession('first-primary');
  const person = await actor(db, request);
  await authorizedRepository(db, person, input.repository, env, input.repositoryId);
  return String(person.id);
}

async function withArtifact(env, row, action, defaultHead = false) {
  const measure = (name, action) => env.timings ? env.timings.measure('artifacts', () => env.timings.measure('artifact_' + name, action)) : action();
  const repo = await measure('open', () => env.ARTIFACTS.get(row.artifact_name));
  try {
    // Only independent reads overlap; settle both before disposing the provider handle.
    const reads = await Promise.allSettled([measure('info', () => repo.info()), ...(defaultHead ? [measure('log', () => repo.log({ ref: row.default_branch, limit: 1 }))] : [])]);
    for (const read of reads) if (read.status === 'rejected') throw read.reason;
    const info = reads[0].value;
    if (info.name !== row.artifact_name || info.remote !== remote(env, row.artifact_name)) throw Error('provider identity changed');
    const observed = new Proxy(repo, { get(target, key) { const value = target[key]; return typeof value === 'function' && typeof key === 'string' ? (...args) => measure(key, () => target[key](...args)) : value; } });
    return await action(cachedRepository(observed, env.gitObjectCache, [env.ACCOUNT_ID, env.ARTIFACTS_NAMESPACE, row.artifact_name], env.timings), info, reads[1]?.value);
  } finally { repo[Symbol.dispose](); }
}

function wireRepository(row, env, empty) {
  const fullName = `${env.WORKSPACE_SLUG}/${row.name}`;
  return { id: String(row.id), name: row.name, fullName, description: row.description, private: true,
    htmlUrl: `${env.PUBLIC_ORIGIN}/${fullName}`, cloneUrl: `${env.PUBLIC_ORIGIN}/git/${fullName}.git`,
    defaultBranch: row.default_branch, updatedAt: row.created_at, empty,
    issuesEnabled: true, pullRequestsEnabled: true, wikiEnabled: false };
}

async function repository(row, env) {
  return withArtifact(env, row, async (_repo, _info, head) => wireRepository(row, env, head.length === 0), true);
}

function creation(row) {
  return { id: String(row.id), idempotencyKey: row.creation_key,
    state: row.state === 'ACTIVE' ? 'REPOSITORY_CREATION_STATE_SUCCEEDED' : 'REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN',
    requestedName: row.name, private: true, createdAt: row.created_at, updatedAt: row.created_at,
    repositoryId: row.state === 'ACTIVE' ? String(row.id) : '', inputSha256: row.input_hash };
}

async function createRepository(db, env, person, body) {
  if (!person.can_create) deny();
  if (!nameOK(body.name) || typeof body.description !== 'string' && body.description !== undefined ||
      (body.description || '').length > 2000 || body.private !== true || !uuidOK(body.idempotencyKey)) {
    invalid('Provide a private repository, canonical name and UUID v4 operation key.');
  }
  if (body.sourceUrl || body.pullMirror) unsupported();
  const hash = await digest(JSON.stringify([body.name, body.description || '', true]));
  let row = await db.prepare('SELECT * FROM repositories WHERE creator_id=? AND creation_key=?').bind(person.id, body.idempotencyKey).first();
  if (row) {
    if (row.input_hash !== hash) throw new Fault('already_exists', 409, 'Operation key belongs to different inputs.');
  } else {
    if (await db.prepare('SELECT id FROM repositories WHERE name=?').bind(body.name).first()) throw new Fault('already_exists', 409, 'Repository name unavailable.');
    const artifactName = 'repo-' + crypto.randomUUID().replaceAll('-', '');
    const created = await db.prepare(`INSERT INTO repositories(name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at)
      VALUES(?,?,?,?,?,?,'CREATING',?) RETURNING *`).bind(body.name, body.description || '', artifactName, person.id, body.idempotencyKey, hash, new Date().toISOString()).first();
    // The durable CREATING row precedes dispatch. Ambiguous create is never replayed.
    const provider = await env.ARTIFACTS.create(artifactName, { readOnly: false, setDefaultBranch: 'main' });
    if (provider.name !== artifactName || provider.remote !== remote(env, artifactName) || typeof provider.token !== 'string') throw Error('invalid created repository');
    await withArtifact(env, created, async repo => {
      if (await repo.revokeToken(provider.token) !== true) throw Error('initial credential revocation unconfirmed');
    });
    await db.batch([
      db.prepare("INSERT INTO grants(repository_id,user_id,role) VALUES(?,?,'admin')").bind(created.id, person.id),
      db.prepare("UPDATE repositories SET state='ACTIVE' WHERE id=? AND state='CREATING'").bind(created.id),
    ]);
    row = { ...created, state: 'ACTIVE' };
  }
  const result = { creation: creation(row) };
  if (row.state === 'ACTIVE') {
    await authorizedRepository(db, person, { owner: env.WORKSPACE_SLUG, name: row.name }, env);
    result.repository = await repository(row, env);
  }
  return result;
}

async function refs(env, repo, row, providerFetch) {
  return advertisedRefs((await gitRequest(env, repo, row.artifact_name, 'info/refs?service=git-upload-pack', 'git-upload-pack', null, providerFetch)).bytes);
}

async function git(db, env, person, request, url, providerFetch) {
  const route = /^\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!route) deny();
  const row = await authorizedRepository(db, person, { owner: route[1], name: route[2] }, env);
  const advertisement = route[3] === 'info/refs';
  const service = advertisement ? url.searchParams.get('service') : route[3];
  if (!['git-upload-pack', 'git-receive-pack'].includes(service) ||
      (advertisement ? request.method !== 'GET' || url.search !== '?service=' + service : request.method !== 'POST' || url.search)) invalid('Invalid Git request.');
  if (service === 'git-receive-pack' && !['write', 'admin'].includes(row.role)) deny();
  if (request.headers.has('Git-Protocol') && request.headers.get('Git-Protocol') !== 'version=1' && request.headers.get('Git-Protocol') !== 'version=2') invalid('Invalid Git protocol.');
  // v0/v1 advertisement is intentionally used; Git clients can downgrade from v2.
  if (!advertisement && (request.headers.get('Content-Type') !== `application/x-${service}-request` || request.headers.has('Content-Encoding'))) invalid('Invalid Git content.');
  const body = advertisement ? null : await bounded(request.body, 8 * 1024 * 1024);
  let command, rulesVersion;
  if (!advertisement && service === 'git-receive-pack') {
    try { command = receiveCommand(body); } catch { invalid('Only one ordinary SHA-1 branch/tag update per bounded push is supported.'); }
    if (row.write_pending) conflict();
    rulesVersion = await enforceGitRules(db, row, person, command.ref);
  }
  return withArtifact(env, row, async repo => {
    let operation;
    if (command) {
      operation = crypto.randomUUID();
      const reserved = await db.batch([
        db.prepare(`INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at)
          SELECT ?,?,?,?,?,?,'DISPATCHED',? WHERE EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
            LEFT JOIN repository_access_versions a ON a.repository_id=r.id LEFT JOIN native_identity_versions v ON v.user_id=u.id
            WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND r.write_pending IS NULL AND g.user_id=? AND g.role IN ('write','admin') AND u.active=1
            AND COALESCE(a.version,0)=? AND COALESCE(v.version,0)=? AND COALESCE((SELECT version FROM repository_rules WHERE repository_id=r.id),0)=?
            AND (?='' OR EXISTS(SELECT 1 FROM credentials WHERE digest=? AND user_id=u.id AND revoked=0 AND expires_at>CAST(strftime('%s','now') AS INTEGER)))
            AND (?='' OR EXISTS(${gitCredentialSQL} AND c.repository_id=? AND c.mode=2)))`)
          .bind(operation, row.id, person.id, command.ref, command.old, command.next, new Date().toISOString(),row.id,row.artifact_name,person.id,row.access_version||0,person.identity_version||0,rulesVersion,person.credential_digest||'',person.credential_digest||'',person.git_credential_digest||'',person.git_credential_digest||'',row.id),
        db.prepare('UPDATE repositories SET write_pending=? WHERE id=? AND write_pending IS NULL AND changes()=1 AND EXISTS(SELECT 1 FROM git_operations WHERE id=?)').bind(operation, row.id, operation),
      ]);
      if (reserved[1].meta.changes !== 1) conflict();
    }
    const result = await gitRequest(env, repo, row.artifact_name, advertisement ? 'info/refs?service=' + service : service, service, body, providerFetch);
    if (operation) {
      const observed = (await refs(env, repo, row, providerFetch)).get(command.ref) || '0'.repeat(40);
      if (observed !== command.next) conflict();
      await db.batch([
        db.prepare("UPDATE git_operations SET state='APPLIED',ci_state=? WHERE id=? AND state='DISPATCHED'").bind(env.CI_AUTO === 'true' && evidencePolicy(env) && testPolicy(env) ? 'PENDING' : 'NONE', operation),
        db.prepare('UPDATE repositories SET write_pending=NULL WHERE id=? AND write_pending=?').bind(row.id, operation),
      ]);
    }
    await confirmGitCredential(db,person,row);
    const bytes=advertisement&&service==='git-upload-pack'?defaultBranchAdvertisement(result.bytes,row.default_branch):result.bytes;
    return new Response(bytes, { headers: { ...jsonHeaders, 'Content-Type': result.contentType } });
  });
}

async function grants(db, env, person, request, body) {
  const row = await authorizedRepository(db, person, body.repository, env, body.repositoryId);
  if (row.role !== 'admin' || !/^[1-9][0-9]*$/.test(body.userId)) deny();
  if (!['read', 'write', 'none'].includes(body.role)) invalid('Use read, write or none; administrator transfer is not supported.');
  if (String(person.id) === body.userId) invalid('Cannot remove the current repository administrator.');
  if (!await db.prepare('SELECT id FROM users WHERE id=? AND active=1').bind(body.userId).first()) deny();
  if (body.role === 'none') await db.prepare('DELETE FROM grants WHERE repository_id=? AND user_id=?').bind(row.id, body.userId).run();
  else await db.prepare(`INSERT INTO grants(repository_id,user_id,role) VALUES(?,?,?)
    ON CONFLICT(repository_id,user_id) DO UPDATE SET role=excluded.role`).bind(row.id, body.userId, body.role).run();
  return { repositoryId: String(row.id), userId: body.userId, role: body.role };
}

function literalPath(path) {
  if (typeof path !== 'string' || path.length > 1024 || path.split('/').length > 32 ||
      path && path.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\\]/.test(path)) invalid('Use a literal repository path.');
  return path;
}

const sourceKinds = { tree: 'DIRECTORY', blob: 'FILE', exec: 'FILE', symlink: 'SYMLINK', gitlink: 'SUBMODULE' };
function entryKind(entry) {
  if (!sourceKinds[entry.type] || !sha(entry.hash)) throw Error('Invalid tree entry');
  return 'SOURCE_ENTRY_TYPE_' + sourceKinds[entry.type];
}
async function readTree(repo, hash) {
  const tree = await repo.readTree(hash);
  if (!tree) deny();
  if (tree.length > 10000) throw new Fault('resource_exhausted', 429, 'Directory exceeds the 10,000-entry inventory bound.');
  const names = new Set();
  for (const entry of tree) {
    literalPath(entry.name);
    if (!entry.name || entry.name.includes('/') || names.has(entry.name)) throw Error('Invalid tree entry');
    entryKind(entry); names.add(entry.name);
  }
  return tree;
}
async function sourceEntry(repo, entry, path) {
  const result = { name: entry.name, path, sha: entry.hash, type: entryKind(entry) };
  if (['blob', 'exec', 'symlink'].includes(entry.type)) {
    const size = await repo.readBlobSize(entry.hash);
    if (!Number.isSafeInteger(size) || size < 0) throw Error('Invalid blob');
    result.size = String(size);
  }
  return result;
}

export async function handle(request, env, providerFetch = fetch, imageFetch = fetch) {
  const start = performance.now(), clock = timings();
  const configured = { ...env, timings: clock, DB: timedDatabase(env.DB, clock) };
  const response = await handleRequest(request, configured, providerFetch, imageFetch);
  if (response.ok && configured.readAuthority && env.confirmRead) {
    try { await clock.measure('authority', () => env.confirmRead(configured.readAuthority, clock)); }
    catch (error) { return timedResponse(reply(error instanceof Fault ? { code: error.code, message: error.message } : { code: 'unavailable', message: 'Repository access could not be confirmed.' }, error instanceof Fault ? error.status : 503), clock, 'native', performance.now() - start); }
  }
  return timedResponse(response, clock, 'native', performance.now() - start);
}
async function handleRequest(request, env, providerFetch, imageFetch) {
  try {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN) throw new Fault('permission_denied', 403, 'Request origin is not the configured public origin.');
    if ( /%|\\/.test(url.pathname) || request.headers.has('Upgrade')) deny();
    const origin = request.headers.get('Origin');
    if (origin && origin !== env.PUBLIC_ORIGIN) throw new Fault('permission_denied', 403, 'Cross-origin request denied.');
    const db = env.DB.withSession('first-primary');
    const person = await env.timings.measure('actor', () => actor(db, request));
    // Connect streaming bodies must receive an availability error, not JSON parsing errors that retry forever.
    if (url.pathname === '/rpc/golf.v1.RepositoryActivityService/WatchRepository') {
      if (env.watchRepository) return await env.watchRepository(request);
      if (request.method !== 'POST' || url.search) invalid('Use a Connect stream POST.');
      const type = request.headers.get('Content-Type')?.split(';')[0];
      if (!['application/connect+proto', 'application/connect+json'].includes(type)) unsupported();
      const error = new TextEncoder().encode(JSON.stringify({ error: { code: 'unimplemented', message: 'Use manual repository refresh on this installation.' } }));
      const frame = new Uint8Array(5 + error.length); frame[0] = 2; new DataView(frame.buffer).setUint32(1, error.length); frame.set(error, 5);
      return new Response(frame, { headers: { ...jsonHeaders, 'Content-Type': type } });
    }
    if (url.pathname.startsWith('/git/')) return await git(db, env, person, request, url, providerFetch);
    if (request.method !== 'POST' || url.search || request.headers.get('Connect-Protocol-Version') !== '1') invalid('Use Connect JSON POST.');
    const body = await input(request);
    if (url.pathname === '/rpc/golf.v1.OperationsService/GetOperationsDashboard') return await operationsDashboard(db, env, person, request);
    if (url.pathname === '/native/diagnostics') {
      const columns = await db.prepare('PRAGMA table_info(repositories)').all();
      const indexes = await db.prepare('PRAGMA table_info(repository_indexes)').all();
      const budget = await db.prepare('PRAGMA table_info(repository_index_budget)').all();
      const operations = await db.prepare('PRAGMA table_info(operations_maintenance)').all();
      const access = await db.prepare('PRAGMA table_info(repository_access_operations)').all();
      return reply({ release, contract: 1, schema: (await db.prepare('PRAGMA table_info(pull_review_operations)').all()).results.length ? 18 : (await db.prepare('PRAGMA table_info(git_credentials)').all()).results.length ? 17 : (await db.prepare('PRAGMA table_info(repository_rule_operations)').all()).results.length ? 16 : (await db.prepare('PRAGMA table_info(webhook_subscriptions)').all()).results.length ? 15 : (await db.prepare('PRAGMA table_info(discussion_events)').all()).results.length ? 14 : (await db.prepare('PRAGMA table_info(discussion_resources)').all()).results.length ? 13 : (await db.prepare('PRAGMA table_info(repository_invitations)').all()).results.length ? 12 : access.results.length ? 11 : operations.results.length ? 10 : budget.results.length ? 9 : indexes.results.some(column => column.name === 'payload_hash') ? 8 : columns.results.some(column => column.name === 'default_branch') ? 7 : 6,
        configuration, runtimeProfile: 'cloudflare-native', workspace: env.WORKSPACE_SLUG });
    }
    if (url.pathname === '/native/preview-resume') {
      if (!uuidOK(body.previewId)) invalid('Use a canonical preview ID.');
      const preview = await db.prepare('SELECT * FROM previews WHERE id=?').bind(body.previewId).first();
      if (!preview) deny();
      const stored = await db.prepare('SELECT * FROM repositories WHERE id=?').bind(preview.repository_id).first();
      if (!stored) deny();
      const row = await authorizedRepository(db, person, { owner: env.WORKSPACE_SLUG, name: stored.name }, env, String(stored.id));
      return await previewAPI(db, env, person, row, action => withArtifact(env, row, action), { action: 'grant', previewId: preview.id });
    }
    if (url.pathname === '/native/config') return reply({ runtimeProfile: 'cloudflare-native', workspace: env.WORKSPACE_SLUG, accessLogin: Boolean(env.ACCESS_AUD), canCreate: Boolean(person.can_create),
      evidence: evidencePolicy(env), tests: Boolean(testPolicy(env)), agents: Boolean(agentPolicy(env)),
      advice: env.EVIDENCE_ALLOW_AI === 'true', previews: previewPolicy(env), apps: Boolean(appPolicy(env)), automaticCI: env.CI_AUTO === 'true', appPath: appPolicy(env)?.entry || '',
      browser: Boolean(env.BROWSER && env.PREVIEW_BROWSER === 'true'), previewPath: env.PREVIEW_PATH || '', agentPath: env.AGENT_PATH || '',
      testModule: env.TEST_MODULE || '', dailyLimit: Number(env.EVIDENCE_DAILY_LIMIT) || 0, previewTTL: Number(env.PREVIEW_TTL) || 0, appTTL: appPolicy(env)?.ttl || 0 });
    if (url.pathname === '/native/repository-access') {
      const row = await authorizedRepository(db, person, body.repository, env, body.repositoryId);
      if (body.repositoryId !== String(row.id)) deny();
      return reply({ role: row.role });
    }
    if (url.pathname === '/native/repository-packages') {
      const row = await authorizedRepository(db, person, body.repository, env, body.repositoryId);
      return reply(await repositoryPackages(env, person, row, body));
    }
    if (url.pathname === '/native/pr-preview') {
      const row = await authorizedRepository(db, person, body.repository, env, body.repositoryId);
      if (body.repositoryId !== String(row.id)) deny();
      return await previewAPI(db, env, person, row, action => withArtifact(env, row, action), body);
    }
    if (url.pathname === '/native/pr-evidence') {
      const key = body.action === 'create' ? body.selection?.repository : body.repository;
      const id = body.action === 'create' ? body.selection?.repositoryId : body.repositoryId;
      const row = await authorizedRepository(db, person, key, env, id);
      if (id !== String(row.id)) deny();
      return await evidenceAPI(db, env, person, row, action => withArtifact(env, row, action), body);
    }
    if (url.pathname === '/native/repository-check') {
      const row = await authorizedRepository(db, person, body.repository, env, body.repositoryId);
      return reply(await collaboration(db, env, person, 'ReportCheck', body, row, action => withArtifact(env, row, action)));
    }
    if (url.pathname === '/native/repository-grant') return reply(await grants(db, env, person, request, body));
    const route = /^\/rpc\/golf\.v1\.(SessionService|RepositoryService|CapabilityService|ProfileService|OrganizationService|RepositorySettingsService|RepositoryAccessService|RepositoryInvitationService|RepositoryWebhookService|RepositoryRulesService|GitTransportService|PullReviewRequestService|PullReviewAuthoringService|PullMergeObservationService|DiscussionCollaborationService)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!route) unsupported();
    const [, service, method] = route;
    if (service === 'PullReviewAuthoringService' && !reviewAuthoringMethods.has(method) || service === 'PullReviewRequestService' && !pullReviewMethods.has(method) || service === 'RepositoryRulesService' && !ruleMethods.has(method) || service === 'GitTransportService' && !gitCredentialMethods.has(method)) unsupported();
    if (service === 'ProfileService') return reply(await profile(db, person, method, body));
    if (service === 'OrganizationService') return reply(await organizations(db, env, method, body));
    if (service === 'SessionService') {
      if (method === 'GetSession') return reply({ user: { ...user(person), isInstanceAdmin: await operationsAdmin(db, person, request) } });
      if (method === 'GetAuthenticationOptions') return reply({ providerLabel: 'Cloudflare Access' });
      unsupported();
    }
    if (service === 'CapabilityService' && method === 'ListCapabilities') return reply({ runtimeProfile: 'cloudflare-native', capabilities: [
      { id: 'operations.dashboard', label: 'Operations dashboard', state: 'CAPABILITY_STATE_READY', reason: 'Current workspace administrators; durable inventories and maintenance observations. Provider usage/billing remain uncollected.' },
      { id: 'native-artifacts-git', label: 'Artifacts repositories', state: 'CAPABILITY_STATE_READY', reason: 'Private repositories; bounded unprotected single-ref Git.' },
      { id: 'native-forge-collaboration', label: 'Native collaboration', state: 'CAPABILITY_STATE_READY', reason: 'Issues/comments, same-repository PRs, overall reviews and reported checks.' },
      { id: 'native-pr-evidence', label: 'Private PR evidence', state: evidencePolicy(env) ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Operator-allocated Queues, Workflows and R2; optional advisory Clef inference.' },
      { id: 'native-pr-tests', label: 'PR container tests', state: evidencePolicy(env) && testPolicy(env) ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Operator-approved Python unittest module on the exact PR head; private results, no merge authority.' },
      { id: 'native-pr-agents', label: 'Private PR agent proposals', state: evidencePolicy(env) && agentPolicy(env) ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Approved single-file OpenCode proposals in isolated Artifacts forks; observed tests, private context and no merge authority.' },
      { id: 'native-pr-analytics', label: 'PR evidence metrics', state: env.USAGE_ANALYTICS ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Configured Analytics Engine binding; sampled completion metrics, not authoritative billing or quota.' },
      { id: 'native-pr-previews', label: 'Protected static PR previews', state: previewPolicy(env) ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Exact passing canonical source; private R2 assets, Access identity, expiring Golf reviewer grants and current repository permissions.' },
      { id: 'native-preview-browser', label: 'Private visual snapshots', state: previewPolicy(env) && env.BROWSER && env.PREVIEW_BROWSER === 'true' ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'One Browser Run Quick Action per preview; captured index HTML, no scripts or external requests, private PNG in R2.' },
      { id: 'native-pr-apps', label: 'Protected Worker applications', state: appPolicy(env) ? 'CAPABILITY_STATE_DEGRADED' : 'CAPABILITY_STATE_DISABLED', reason: 'Operator allocation enables the prebundled module/schema consumer. Each preview verifies provider identity and bindings; human browser acceptance and complete recovery remain required.' },
      { id: 'native-ci-automatic', label: 'Automatic PR push tests', state: env.CI_AUTO === 'true' && testPolicy(env) && evidencePolicy(env) ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Confirmed single-ref pushes only; durable admission uses current writer permissions and the approved exact-source test policy.' },
      { id: 'settings.repository-general', label: 'Repository general settings', state: 'CAPABILITY_STATE_READY', reason: 'Current administrators can edit description, website, topics and an existing default branch with atomic authority/revision checks. Feature policies remain operator-managed.' },
      { id: 'ci.registry-publish', label: 'Job-scoped image publishing', state: env.REGISTRY && env.REGISTRY_CI_ENABLED === 'true' && testPolicy(env) ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Operator-enabled OCI publishing from approved PR jobs. Job-only tags, current source/access checks and immutable digest receipts; general Docker build workflows remain separate.' },
      { id: 'repository.packages', label: 'OCI packages', state: env.REGISTRY && env.REGISTRY_ORIGIN ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Separate CFCR service; administrator enablement, current Git access and repository-scoped registry credentials.' },
      { id: 'repository.live', label: 'Live activity stream', state: env.watchRepository ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: env.watchRepository ? 'Authorized, resumable Connect streams; source snapshots stay pinned.' : 'No live stream coordinator is installed.' },
      { id: 'settings.repository-rules', label: 'Rules and merge policy', state: 'CAPABILITY_STATE_READY', reason: 'Enforced branch locks and tag account restrictions on Golf-brokered Git writes, including administrators. Literal and trailing-prefix patterns; protected merge, review/check requirements and direct provider writes are not covered.' },
      { id: 'settings.repository-webhooks', label: 'Webhooks', state: webhookPolicy(env) ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: webhookPolicy(env) ? 'Encrypted subscriptions, signed delivery and retries to operator-approved HTTPS origins; current sponsor authority, delivery history and daily attempt limits. Actions events cover native test jobs.' : 'Configure a dedicated Secrets Store encryption key and approved HTTPS webhook origins.' },
      { id: 'repository.email-notifications', label: 'Repository email notifications', state: 'CAPABILITY_STATE_DISABLED', reason: 'Native repository email delivery is not implemented.' },
      { id: 'settings.repository-access', label: 'Repository collaborators', state: 'CAPABILITY_STATE_READY', reason: 'Enrolled accounts; direct read/write/admin grants, revision-fenced changes and durable original receipts.' },
      { id: 'settings.repository-invitations', label: 'Repository invitations', state: env.ACCESS_AUD ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Access-authenticated enrolled accounts; expiring consent, current issuer authority and atomic acceptance receipts.' },
      { id: 'settings.repository-git', label: 'Git credentials', state: env.ACCESS_AUD ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Access-authenticated own-account HTTPS credentials scoped to one repository, read/write mode and at most one hour; current identity/grant generations, explicit revocation and Git rules. Access machine admission is separately required.' },
      ...[
        ['settings.repository-teams', 'Repository team access', 'Team membership and inherited repository permissions are not implemented on Cloudflare native. Direct collaborators and invitations are available in Access.'],
        ['settings.repository-deploy-keys', 'SSH deploy keys', 'Cloudflare native serves Git over HTTPS. SSH transport and SSH deploy keys are not available.'],
        ['settings.repository-secrets', 'Secrets and variables', 'Repository secret and variable management for general workflows is not implemented on Cloudflare native. Operator-managed execution bindings do not provide this editor.'],
        ['settings.repository-environments', 'Environments', 'Protected previews use operator-approved allocation policies. Repository environment configuration, approval rules and production promotion through this settings page are not implemented on Cloudflare native.'],
        ['settings.repository-workflows', 'Workflows', 'Cloudflare native supports approved, bounded PR test jobs. The general workflow configuration editor and full Actions workflow execution are not implemented on this runtime.'],
        ['settings.repository-lifecycle', 'Archive, transfer and deletion'],
        ['settings.repository-agents', 'Agent policy editor'],
        ['repository.source-write', 'Browser file editing'], ['pull.advanced-reviews', 'Inline and pending reviews'],
        ['pull.merge', 'Merge execution'],
        ['discussion.attachments', 'Discussion attachments'], ['discussion.templates', 'Issue templates'],
        ['repository.releases', 'Releases'], ['repository.wiki', 'Wiki workspace'],
      ].map(([id, label, reason]) => ({ id, label, state: 'CAPABILITY_STATE_DISABLED', reason: reason || 'This feature is not available in the Cloudflare-native installation yet.' })),
      { id: 'settings.native', label: 'Cloudflare allocation settings', state: 'CAPABILITY_STATE_READY', reason: 'Current allocations are readable. Operators change the separate native installation configuration; provider credentials are never exposed in the UI.' },
      ...[['settings.infrastructure', 'Portable database and storage profiles'], ['settings.runners', 'Portable runner pools'], ['settings.local-auth', 'Golf passwords, MFA and SSH keys'], ['settings.notifications', 'Portable SMTP settings'], ['settings.cloudflare-resources', 'Origin bridge resource allocation']].map(([id, label]) => ({ id, label, state: 'CAPABILITY_STATE_DISABLED', reason: 'This editor belongs to the portable/origin installation. Cloudflare native uses its separate identity, binding and allocation setup.' })),
      { id: 'discussion.activity', label: 'Discussion activity, reactions and inbox', state: 'CAPABILITY_STATE_READY', reason: 'Native reactions, subscriptions, permission-filtered inbox and activity recorded since schema14. In-app notifications; email and issue templates are separate.' },
      { id: 'discussion.comments', label: 'Comment editing', state: 'CAPABILITY_STATE_READY', reason: 'Authors and current administrators can edit or delete an exact discussion comment; atomic original receipts and revision checks.' },
      { id: 'discussion.resources', label: 'Labels, milestones and assignees', state: 'CAPABILITY_STATE_READY', reason: 'Repository resources and issue/PR assignment with version-fenced D1 writes and original receipts. Organization labels remain separate.' },
      { id: 'pull.pending-reviews', label: 'Pending review summaries', state: env.ACCESS_AUD ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Requires verified human Access identity. Private own-account pending summaries, editing, exact-source publication and discard. Inline and saved-diff drafts remain separate.' },
      { id: 'pull.review-requests', label: 'Review assignments', state: env.ACCESS_AUD ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Requires verified human Access identity. Current enrolled repository accounts; request/cancel, versioned receipts and live activity. Teams and CODEOWNERS are separate.' },
      { id: 'pull.review-lifecycle', label: 'Review dismissal and restoration', state: env.ACCESS_AUD ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED', reason: 'Requires verified human Access identity. Repository administrators can dismiss reviews and restore only the latest non-stale review. These decisions do not authorize protected merge.' },
      { id: 'pull.codeowners', label: 'CODEOWNERS routing', state: 'CAPABILITY_STATE_READY', reason: 'Bounded GitHub-format CODEOWNERS suggestions from the exact PR base. No automatic requests or protected approval authority; unsupported patterns are explicit.' },
      { id: 'pull.merge-observation', label: 'Merge diagnostics', state: 'CAPABILITY_STATE_READY', reason: 'Exact source and target, current writer and branch-lock observations. Publication remains disabled.' },
      { id: 'native-protected-merge', label: 'Protected merge', state: 'CAPABILITY_STATE_DISABLED', reason: 'Not implemented on this native path.' },
    ] });
    if (service === 'CapabilityService') unsupported();
    if (service === 'DiscussionCollaborationService' && method === 'ListOwnForgeNotifications') return reply(await engagement(db, env, person, null, method, body));
    if (service === 'RepositoryInvitationService' && ownInvitationMethods.has(method)) return reply(await invitations(db, env, person, null, method, body, request));
    if (service === 'RepositoryService' && method === 'GetDiscussionResourceOperation') return reply(await resourceOperation(db, person, body.operationId));
    if (method === 'CreateRepository') return reply(await createRepository(db, env, person, body));
    if (method === 'GetRepositoryCreation') {
      if (!uuidOK(body.idempotencyKey)) invalid('Use the original operation key.');
      const row = await db.prepare('SELECT * FROM repositories WHERE creator_id=? AND creation_key=?').bind(person.id, body.idempotencyKey).first();
      if (!row) deny();
      const value = { creation: creation(row) };
      if (row.state === 'ACTIVE') value.repository = await repository(await authorizedRepository(db, person, { owner: env.WORKSPACE_SLUG, name: row.name }, env), env);
      return reply(value);
    }
    if (method === 'ListRepositories') {
      const paging = page(body);
      const { results } = await db.prepare(`SELECT r.*,COALESCE(s.description,r.description) AS description FROM repositories r JOIN grants g ON g.repository_id=r.id LEFT JOIN repository_settings s ON s.repository_id=r.id
        WHERE g.user_id=? AND r.state='ACTIVE' ORDER BY r.id LIMIT ? OFFSET ?`).bind(person.id, paging.limit + 1, paging.offset).all();
      const repositories = [];
      const selected = results.slice(0, paging.limit);
      // Bound independent provider reads; preserve the authorized inventory order.
      for (let offset = 0; offset < selected.length; offset += 4)
        repositories.push(...await Promise.all(selected.slice(offset, offset + 4).map(row => repository(row, env))));
      return reply({ repositories, page: { nextPage: results.length > paging.limit ? paging.number + 1 : 0 } });
    }
    const row = ['GetIssueMutation', 'GetPullRequestReviewMutation'].includes(method)
      ? await operationRepository(db, person, body.idempotencyKey)
      : await env.timings.measure('grant', () => authorizedRepository(db, person, body.repository || body.selection?.repository || body.target?.repository, env, body.repositoryId || body.selection?.repositoryId || body.target?.repositoryId));
    env.readAuthority = { repository: { owner: env.WORKSPACE_SLUG, name: row.name }, repositoryId: String(row.id), role: row.role };
    if (service === 'DiscussionCollaborationService' && engagementMethods.has(method)) return reply(await engagement(db, env, person, row, method, body));
    if (service === 'RepositorySettingsService') return reply(await repositorySettings(db, env, person, row, method, body, action=>withArtifact(env,row,action)));
    if (service === 'RepositoryInvitationService') return reply(await invitations(db, env, person, row, method, body, request));
    if (service === 'GitTransportService') return reply(await gitCredentials(db,env,person,row,request,method,body));
    if (service === 'PullReviewAuthoringService') return reply(await reviewAuthoring(db,env,person,row,request,method,body,action=>withArtifact(env,row,action)));
    if (service === 'PullReviewRequestService' && method==='GetPullCodeOwners') return reply(await pullCodeOwners(db,env,person,row,body,action=>withArtifact(env,row,action)));
    if (service === 'PullReviewRequestService') return reply(await pullReviews(db,env,person,row,request,method,body,action=>withArtifact(env,row,action)));
    if (service === 'PullMergeObservationService') {
      if(method !== 'GetPullRequestMergeObservation') unsupported();
      return reply(await pullMergeObservation(db,env,person,row,body,action=>withArtifact(env,row,action)));
    }
    if (service === 'RepositoryRulesService') return reply(await repositoryRules(db, env, person, row, request, method, body));
    if (service === 'RepositoryAccessService') return reply(await repositoryCollaborators(db, env, person, row, method, body));
    if (service === 'RepositoryService' && resourceMethods.has(method)) return reply(await discussionResources(db, env, person, row, method, body));
    if (service === 'RepositoryWebhookService') return reply(await repositoryWebhooks(db, env, person, row, method, body));
    if (collaborationMethods.has(method)) return reply(await collaboration(db, env, person, method, body, row, action => withArtifact(env, row, action)));
    if (method === 'GetRepository') return reply(await withArtifact(env, row, async (_repo, _info, commits) => {
      const head = commits[0]?.hash;
      if (head && !sha(head)) throw Error('Invalid default branch identity');
      return { repository: wireRepository(row, env, !head), ...(head ? { sourceSelection: {
        kind: 'REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH', name: row.default_branch, commitId: head,
      } } : {}) };
    }, true));
    if (method === 'GetRepositoryImage') return reply(await withArtifact(env, row, repo => repositoryImage(repo, row, body, literalPath, imageFetch)));
    if (method === 'GetRepositoryStar' || method === 'SetRepositoryStar') return reply(await stars(db, env, person, row, method, body));
    if (method === 'GetRepositoryOverview') {
      if (body.ref && !sha(body.ref)) invalid('Overview requires an immutable commit.');
      const settings = await db.prepare('SELECT s.website,s.topics,(SELECT count(*) FROM repository_stars WHERE repository_id=r.id) AS stars FROM repositories r LEFT JOIN repository_settings s ON s.repository_id=r.id WHERE r.id=?').bind(row.id).first();
      const selected = body.ref || await withArtifact(env, row, async repo => (await repo.log({ ref: row.default_branch, limit: 1 }))[0]?.hash);
      const metadata = selected ? await indexedRead(db, env, row, { kind: 'overview', ref: selected }, () => withArtifact(env, row, async repo => {
        if (env.metadataIndex) return env.metadataIndex(row, person, repo, selected);
        const root = await rootMetadata(repo, selected);
        return { licenseIds: root.licenseIds, licensePaths: root.licensePaths, indexedCommitId: selected, languages: [], languagesState: 'REPOSITORY_OVERVIEW_SECTION_STATE_UNAVAILABLE', licensesState: 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE' };
      })) : { languages: [], licenseIds: [], languagesState: 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE', licensesState: 'REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE' };
      return reply({ repository: body.repository, repositoryId: String(row.id), description: row.description, website: settings?.website || '', topics: JSON.parse(settings?.topics || '[]'), starsCount: String(settings.stars), ...metadata });
    }
    if (method === 'ListCommits') {
      const read = () => withArtifact(env, row, repo => commits(repo, body, row,
        async name => (await refs(env, repo, row, providerFetch)).get('refs/heads/' + name), literalPath));
      if (sha(body.ref) && body.repositoryId === String(row.id)) {
        const paging = page(body);
        return reply(await indexedRead(db, env, row, { kind: 'commits', ref: body.ref, path: literalPath(body.path || ''), page: paging.number, limit: paging.limit }, read));
      }
      return reply(await read());
    }
    if (method === 'GetCommitDiff') {
      if (!sha(body.commitId)) invalid('Select an immutable commit.');
      return reply(await indexedRead(db, env, row, { kind: 'diff', ref: body.commitId }, () => withArtifact(env, row, async repo => {
        const value = await repo.readCommit(body.commitId); if (!value) deny();
        if (!Array.isArray(value.parents) || value.parents.some(p => !sha(p))) throw Error('Invalid commit parents');
        const base = value.parents[0] || '';
        return { commit: wireCommit(value), parentCommitIds: value.parents, baseCommitId: base,
          base: 'COMMIT_DIFF_BASE_' + (base ? 'FIRST_PARENT' : 'ROOT'), ...await diff(repo, base, body.commitId) };
      })));
    }
    if (method === 'GetRepositoryComparison') {
      const selected = body.selection;
      if (!selected || !sha(selected.baseCommitId) || !sha(selected.headCommitId) || !validRef('refs/heads/' + selected.baseBranch) || !validRef('refs/heads/' + selected.headBranch)) invalid('Select named branches and immutable commits.');
      const source = await authorizedRepository(db, person, selected.sourceRepository, env, selected.sourceRepositoryId);
      if (selected.repositoryId !== String(row.id) || selected.sourceRepositoryId !== String(source.id)) deny();
      if (source.id !== row.id) unsupported();
      return reply(await withArtifact(env, row, async repo => {
        const observed = await refs(env, repo, row, providerFetch);
        if (observed.get('refs/heads/' + selected.baseBranch) !== selected.baseCommitId || observed.get('refs/heads/' + selected.headBranch) !== selected.headCommitId) throw new Fault('failed_precondition', 412, 'The selected comparison branches changed.');
        const result = await comparison(repo, selected.baseCommitId, selected.headCommitId);
        return { selection: selected, commits: result.commits.map(wireCommit), ...await diff(repo, result.mergeBase, selected.headCommitId) };
      }));
    }

    if (method === 'ListBranches' || method === 'ListTags') {
      const inventory = await withArtifact(env, row, repo => refs(env, repo, row, providerFetch));
      const paging = page(body), prefix = method === 'ListBranches' ? 'refs/heads/' : 'refs/tags/';
      const selected = [...inventory].filter(([ref]) => ref.startsWith(prefix) && !ref.endsWith('^{}')).sort(([a], [b]) => a.localeCompare(b));
      const entries = selected.slice(paging.offset, paging.offset + paging.limit).map(([ref, hash]) => ({
        name: ref.slice(prefix.length), commitId: inventory.get(ref + '^{}') || hash, ...(method === 'ListTags' ? { id: hash } : {}),
      }));
      return reply({ [method === 'ListBranches' ? 'branches' : 'tags']: entries,
        repositoryId: String(row.id), totalCount: String(selected.length), page: { nextPage: selected.length > paging.offset + paging.limit ? paging.number + 1 : 0 } });
    }
    if (method === 'ResolveRepositorySource') return reply(await withArtifact(env, row, repo =>
      resolveSource(repo, body, row, () => refs(env, repo, row, providerFetch), literalPath)));
    if (method === 'GetRepositoryFileIndex') {
      if (!sha(body.commitId) || body.repositoryId !== String(row.id)) invalid('Select the repository ID and full commit.');
      return reply(await indexedRead(db, env, row, { kind: 'file-index', ref: body.commitId }, () => withArtifact(env, row, async repo => ({
        repositoryId: String(row.id), commitId: body.commitId, paths: await fileIndex(repo, body.commitId, readTree, literalPath),
      }))));
    }
    if (method === 'GetContents') {
      if (!sha(body.ref)) invalid('Use an immutable commit.');
      const paging = page({ page: body.page || { limit: 100 } });
      const path = literalPath(body.path || '');
      const value = await indexedRead(db, env, row, { kind: 'contents', ref: body.ref, path, page: paging.number, limit: paging.limit, latestChanges: Boolean(body.includeLatestChanges) }, () => withArtifact(env, row, async repo => {
        const commit = await repo.readCommit(body.ref);
        if (!commit) deny();
        if (!sha(commit.treeHash)) throw Error('Invalid commit tree');
        let entry = { name: '', hash: commit.treeHash, type: 'tree', mode: '40000' };
        for (const component of path ? path.split('/') : []) {
          if (entry.type !== 'tree') deny();
          const tree = await readTree(repo, entry.hash);
          entry = tree.find(e => e.name === component);
          if (!entry) deny();
        }
        const base = { commitId: body.ref, path, repositoryId: String(row.id), kind: entryKind(entry) };
        if (entry.type === 'tree') {
          const inventory = (await readTree(repo, entry.hash)).sort((a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          const tree = inventory.slice(paging.offset, paging.offset + paging.limit), entries = [];
          for (let offset = 0; offset < tree.length; offset += 8) entries.push(...await Promise.all(tree.slice(offset, offset + 8).map(child => sourceEntry(repo, child, path ? path + '/' + child.name : child.name))));
          if (body.includeLatestChanges) {
            if (!Array.isArray(commit.parents) || commit.parents.some(parent => !sha(parent))) throw Error('Invalid commit parents');
            let previous = [];
            if (commit.parents[0]) {
              const parent = await repo.readCommit(commit.parents[0]);
              // Shallow snapshots lack parent objects; omit unproven history, not source.
              if (!parent) previous = null;
              else {
                if (!sha(parent.treeHash)) throw Error('Invalid parent tree');
                let directory = { type: 'tree', hash: parent.treeHash };
                for (const component of path ? path.split('/') : []) {
                  if (!directory || directory.type !== 'tree') { directory = null; break; }
                  directory = (await readTree(repo, directory.hash)).find(child => child.name === component);
                }
                if (directory?.type === 'tree') previous = await readTree(repo, directory.hash);
              }
            }
            if (previous) {
              const old = new Map(previous.map(child => [child.name, child]));
              for (let i = 0; i < tree.length; i++) {
                const before = old.get(tree[i].name), after = tree[i];
                if (!before || before.hash !== after.hash || before.type !== after.type || before.mode !== after.mode) entries[i].latestChange = wireCommit(commit);
              }
            }
          }
          return { ...base, entries, totalEntries: inventory.length, page: { nextPage: inventory.length > paging.offset + paging.limit ? paging.number + 1 : 0 } };
        }
        const info = await sourceEntry(repo, entry, path);
        let content, previewReason;
        if (entry.type === 'gitlink') previewReason = 'Submodule reference.';
        else if (Number(info.size) > 256 * 1024) previewReason = 'File exceeds preview limit.';
        else {
          const blob = await repo.readBlob(entry.hash);
          if (!blob) deny();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (content.includes('\0')) content = undefined; } catch { /* binary metadata only */ }
          if (content === undefined) previewReason = 'Binary file.';
        }
        return { ...base, file: { entry: info, ...(content === undefined ? { previewReason } : { content }) } };
      }));
      return reply(value);
    }
    unsupported();
  } catch (error) {
    if (error instanceof GitProviderError) return reply({ code: 'unavailable', message: error.message }, 503);
    if (error instanceof Fault) {
      const response = reply({ code: error.code, message: error.message }, error.status);
      if (error.status===401 && new URL(request.url).pathname.startsWith('/git/')) response.headers.set('WWW-Authenticate','Basic realm="Golf Git"');
      if (/^\/rpc\/golf\.v1\.RepositoryAccessService\/(SetRepositoryCollaborator|RemoveRepositoryCollaborator)$/.test(new URL(request.url).pathname)) response.headers.set('Golf-Access-Effect', 'none');
      return response;
    }
    return reply({ code: 'unavailable', message: 'Native repository operation could not be confirmed.' }, 503);
  }
}

export async function servePreview(env, input) {
  return previewRequest(env, input, async (db, person, id) => {
    const row = await db.prepare(`SELECT r.*,g.role FROM repositories r JOIN grants g ON g.repository_id=r.id
      WHERE r.id=? AND g.user_id=? AND r.state='ACTIVE'`).bind(id, person.id).first();
    return row ? { row, artifact: action => withArtifact(env, row, action) } : null;
  });
}
export { cleanupPreviews };

export async function runCI(env) {
  if (env.CI_AUTO !== 'true' || !evidencePolicy(env) || !testPolicy(env)) return { admitted: 0 };
  const db = env.DB.withSession('first-primary');
  const context = async (userId, repositoryId) => {
    const person = await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(userId).first();
    const row = await db.prepare("SELECT r.*,g.role FROM repositories r JOIN grants g ON g.repository_id=r.id WHERE r.id=? AND r.state='ACTIVE' AND g.user_id=? AND g.role IN ('admin','write')").bind(repositoryId, userId).first();
    return person && row && !row.write_pending ? { person, row, artifact: action => withArtifact(env, row, action) } : null;
  };
  const { results: pushes } = await db.prepare("SELECT * FROM git_operations WHERE state='APPLIED' AND ci_state='PENDING' ORDER BY created_at,id LIMIT 10").all();
  for (const push of pushes) {
    const c = await context(push.user_id, push.repository_id);
    if (!c || !push.ref.startsWith('refs/heads/') || push.new_sha === '0'.repeat(40)) {
      await db.prepare("UPDATE git_operations SET ci_state='REFUSED' WHERE id=?").bind(push.id).run(); continue;
    }
    const branch = push.ref.slice('refs/heads/'.length);
    const { results } = await db.prepare("SELECT d.number FROM discussions d JOIN pull_requests p ON p.discussion_id=d.id WHERE d.repository_id=? AND d.state='OPEN' AND (p.head_branch=? OR p.base_branch=?) ORDER BY d.number LIMIT 11").bind(c.row.id, branch, branch).all();
    if (results.length > 10) { await db.prepare("UPDATE git_operations SET ci_state='REFUSED' WHERE id=?").bind(push.id).run(); continue; }
    const statements = [];
    for (const selected of results) {
      const pr = (await collaboration(db, env, c.person, 'GetPullRequest', { repository: { owner: env.WORKSPACE_SLUG, name: c.row.name }, number: selected.number }, c.row, c.artifact)).pullRequest;
      if ((pr.head.ref === branch ? pr.head.commitId : pr.base.commitId) !== push.new_sha || pr.head.retainedSnapshot || pr.base.retainedSnapshot) continue;
      const selection = { repository: { owner: env.WORKSPACE_SLUG, name: c.row.name }, repositoryId: String(c.row.id), pullRequestId: pr.id,
        number: pr.number, headCommitId: pr.head.commitId, baseCommitId: pr.base.commitId };
      statements.push(db.prepare('INSERT INTO ci_intake(id,operation_id,repository_id,user_id,number,selection,created_at) VALUES(?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), push.id, c.row.id, c.person.id, pr.number, JSON.stringify(selection), new Date().toISOString()));
    }
    statements.push(db.prepare("UPDATE git_operations SET ci_state='RECORDED' WHERE id=? AND ci_state='PENDING'").bind(push.id));
    await db.batch(statements);
  }
  const { results: admissions } = await db.prepare("SELECT * FROM ci_intake WHERE state='PENDING' ORDER BY created_at,id LIMIT 10").all();
  let admitted = 0;
  for (const intake of admissions) {
    const c = await context(intake.user_id, intake.repository_id);
    try {
      if (!c) deny();
      const result = await (await evidenceAPI(db, env, c.person, c.row, c.artifact, { action: 'create', selection: JSON.parse(intake.selection),
        idempotencyKey: intake.id, runTests: true, advice: false })).json();
      await db.prepare("UPDATE ci_intake SET state='ADMITTED',job_id=? WHERE id=? AND state='PENDING'").bind(result.job.id, intake.id).run(); admitted++;
    } catch (error) {
      if (error instanceof Fault) await db.prepare("UPDATE ci_intake SET state='REFUSED',reason=? WHERE id=? AND state='PENDING'").bind(error.code, intake.id).run();
      // Provider uncertainty keeps the original admission key; queue dispatch is already bounded.
    }
  }
  return { admitted };
}

export async function advanceEvidence(env, id, phase, workflows) {
  if (!uuidOK(id) || !['start', 'advice', 'store', 'publish-static', 'publish-app', 'tests', 'finish-tests', 'authorize-test', 'agents', 'finish-agents', 'authorize-agent', 'refuse'].includes(phase)) throw Error('Invalid internal evidence dispatch');
  const db = env.DB.withSession('first-primary');
  const job = await db.prepare('SELECT * FROM evidence_jobs WHERE id=?').bind(id).first();
  let context;
  if (job) {
    const person = await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(job.user_id).first();
    const row = await db.prepare(`SELECT r.*,g.role FROM repositories r JOIN grants g ON g.repository_id=r.id
      WHERE r.id=? AND r.state='ACTIVE' AND g.user_id=? AND g.role IN ('admin','write')`).bind(job.repository_id, job.user_id).first();
    if (person && row) context = { person, row, artifact: action => withArtifact(env, row, action) };
  }
  const result = phase.startsWith('publish-') ? { state: job?.state || 'REFUSED' } : await evidenceStep(db, env, job, context, phase, workflows);
  if (phase === 'publish-static' && result.state === 'SUCCEEDED' && context && job.test_state === 'PASSED' && env.PREVIEW_AUTO === 'true' && previewPolicy(env)) {
    try {
      result.preview = (await (await previewAPI(db, env, context.person, context.row, context.artifact,
        { action: 'create', jobId: id, idempotencyKey: id })).json()).preview;
    } catch (error) {
      // The completed test report remains authoritative when delivery is refused.
      result.preview = { state: error instanceof Fault ? 'REFUSED' : 'OUTCOME_UNKNOWN', code: error instanceof Fault ? error.code : 'unavailable' };
    }
  }
  if (phase === 'publish-app' && result.state === 'SUCCEEDED' && context && job.test_state === 'PASSED' && env.APP_AUTO === 'true' && appPolicy(env)) {
    try {
      const h = await digest(id + ':WORKER'), key = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
      result.app = (await (await previewAPI(db, env, context.person, context.row, context.artifact, { action: 'create', kind: 'WORKER', jobId: id, idempotencyKey: key })).json()).preview;
    } catch (error) { result.app = { state: error instanceof Fault ? 'REFUSED' : 'OUTCOME_UNKNOWN', code: error instanceof Fault ? error.code :
      Number.isInteger(error.cause) && error.cause >= 100 && error.cause <= 599 ? 'provider_http_' + error.cause :
      error.message === 'Application bindings differ' ? 'bindings_readback' : error.message === 'Application script readback differs' ? 'script_readback' : 'unavailable' }; }
  }
  return result;
}

export async function testGit(env, id, request, workflows, providerFetch = fetch) {
  if ((await advanceEvidence(env, id, 'authorize-test', workflows)).state !== 'AUTHORIZED') return new Response('denied', { status: 403 });
  const db = env.DB.withSession('first-primary');
  const job = await db.prepare('SELECT * FROM evidence_jobs WHERE id=?').bind(id).first();
  if (job.test_state !== 'RUNNING') return new Response('denied', { status: 403 });
  const row = await db.prepare('SELECT * FROM repositories WHERE id=?').bind(job.repository_id).first();
  const url = new URL(request.url), base = remote(env, row.artifact_name);
  const read = request.method === 'GET' && request.url === base + '/info/refs?service=git-upload-pack';
  const upload = request.method === 'POST' && request.url === base + '/git-upload-pack';
  if (!read && !upload || url.username || url.password || url.hash || request.headers.has('Content-Encoding')) return new Response('denied', { status: 403 });
  const body = upload ? await bounded(request.body, 1024 * 1024) : null;
  return withArtifact(env, row, async repo => {
    const result = await gitRequest(env, repo, row.artifact_name, read ? 'info/refs?service=git-upload-pack' : 'git-upload-pack', 'git-upload-pack', body, providerFetch, request.headers.get('Git-Protocol'));
    return new Response(result.bytes, { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store' } });
  });
}

export async function registryExecution(env, actorId, row, execution) {
  if (env.REGISTRY_CI_ENABLED !== 'true' || execution?.contract !== 'golf.registry-job.v1' || !uuidOK(execution.jobId) || !sha(execution.commitId) || !/^[a-f0-9]{64}$/.test(execution.policySha256||'') || !Number.isSafeInteger(execution.expiresAt) || execution.expiresAt <= Date.now()) return false;
  const job=await env.DB.withSession('first-primary').prepare('SELECT * FROM evidence_jobs WHERE id=? AND repository_id=? AND user_id=?').bind(execution.jobId,row.id,actorId).first();
  if (!job || job.state!=='QUEUED' || job.test_state!=='RUNNING' || row.write_pending || Date.parse(job.expires_at)!==execution.expiresAt) return false;
  const snapshot=JSON.parse(job.snapshot);
  if (snapshot.execution?.commitId!==execution.commitId || snapshot.execution.policySha256!==execution.policySha256 || snapshot.execution.registry?.origin!==env.REGISTRY_ORIGIN || snapshot.execution.registry?.name!==env.WORKSPACE_SLUG+'/'+row.name) return false;
  return (await advanceEvidence(env,job.id,'authorize-test')).state==='AUTHORIZED';
}

// Credentials stay in the trusted broker; repository code receives only OCI responses.
export async function testRegistry(env,id,request) {
  try { return await brokerRegistry(env,id,request); }
  catch (error) { return new Response(executionDiagnostic(error), { status: 503, headers: { 'X-Golf-Registry-Broker-Error': '1', 'Cache-Control': 'no-store' } }); }
}

async function brokerRegistry(env,id,request) {
  const refused=()=>new Response('denied',{status:403});
  if (!env.REGISTRY || env.REGISTRY_CI_ENABLED!=='true' || !uuidOK(id)) return refused();
  const url=new URL(request.url);
  if (url.origin!==env.REGISTRY_ORIGIN || url.username || url.password || url.hash || /[%\\]/.test(url.pathname) || request.headers.has('Content-Encoding') || !['GET','HEAD','POST','PATCH','PUT'].includes(request.method)) return refused();
  const db=env.DB.withSession('first-primary'),job=await db.prepare('SELECT * FROM evidence_jobs WHERE id=?').bind(id).first();
  if(!job) return refused();
  const row=await db.prepare("SELECT * FROM repositories WHERE id=? AND state='ACTIVE'").bind(job.repository_id).first();
  if(!row) return refused();
  const name=env.WORKSPACE_SLUG+'/'+row.name;
  if(url.pathname!=='/v2/' && !url.pathname.startsWith('/v2/'+name+'/')) return refused();
  const snapshot=JSON.parse(job.snapshot),execution={contract:'golf.registry-job.v1',jobId:id,commitId:snapshot.execution?.commitId,policySha256:snapshot.execution?.policySha256,expiresAt:Date.parse(job.expires_at)};
  if(!await registryExecution(env,String(job.user_id),row,execution)) return refused();
  const cache=env.registryCredentials ||= new Map();
  for(const [key,value] of cache) if(value.expiresAt<=Date.now()) cache.delete(key);
  if(!cache.has(id)) {
    if(cache.size>=20) throw new Fault('resource_exhausted',429,'Registry job credential capacity reached.');
    const binding={contract:1,installation:env.PUBLIC_ORIGIN,name,repositoryId:String(row.id),artifactName:row.artifact_name};
    const result=await env.REGISTRY.manage({action:'jobCredential',binding,actorId:String(job.user_id),execution});
    if(result.registryError?.status>=500) throw Error('Registry management: '+(result.registryError.diagnostic || result.registryError.message));
    if(result.registryError || result.name!==name || result.registry!==env.REGISTRY_ORIGIN || result.expiresAt!==execution.expiresAt || typeof result.credential!=='string' || result.credential.length>1024 || !/^[\x21-\x7e]+$/.test(result.credential)) return refused();
    cache.set(id,{credential:result.credential,expiresAt:result.expiresAt});
  }
  const saved=cache.get(id);
  if(!saved.token || saved.tokenExpiresAt<=Date.now()+5000) {
    const response=await env.REGISTRY.fetch(new Request(env.REGISTRY_ORIGIN+'/token?service=cfcr&scope=repository:'+name+':pull,push',{headers:{Authorization:'Basic '+btoa('golf:'+saved.credential)}}));
    if(!response.ok) return refused();
    const token=await response.json();
    if(typeof token.token!=='string' || token.token.length>1024 || !/^[\x21-\x7e]+$/.test(token.token) || !Number.isInteger(token.expires_in) || token.expires_in<1 || token.expires_in>300) throw Error('Invalid registry token response');
    saved.token=token.token;saved.tokenExpiresAt=Math.min(saved.expiresAt,Date.now()+token.expires_in*1000);
  }
  const headers=new Headers({Authorization:'Bearer '+saved.token});
  for(const name of ['Content-Type','Content-Length','Content-Range','Range','Accept','If-None-Match','If-Range']) if(request.headers.has(name)) headers.set(name,request.headers.get(name));
  return env.REGISTRY.fetch(new Request(url,{method:request.method,headers,body:request.body,redirect:'manual',...(request.body?{duplex:'half'}:{})}));
}

export async function agentGit(env, id, request, phase, workflows, providerFetch = fetch) {
  if (!['clone', 'publish'].includes(phase) || (await advanceEvidence(env, id, 'authorize-agent', workflows)).state !== 'AUTHORIZED') return new Response('denied', { status: 403 });
  const db = env.DB.withSession('first-primary');
  const job = await db.prepare('SELECT * FROM evidence_jobs WHERE id=?').bind(id).first(), snapshot = JSON.parse(job.snapshot);
  const base = remote(env, job.agent_fork), service = phase === 'clone' ? 'git-upload-pack' : 'git-receive-pack';
  const url = new URL(request.url), advertisement = request.method === 'GET' && request.url === base + '/info/refs?service=' + service;
  const post = request.method === 'POST' && request.url === base + '/' + service;
  if ((!advertisement && !post) || url.username || url.password || url.hash || request.headers.has('Content-Encoding') ||
      post && request.headers.get('Content-Type') !== `application/x-${service}-request`) return new Response('denied', { status: 403 });
  const body = post ? await bounded(request.body, phase === 'clone' ? 1024 * 1024 : 8 * 1024 * 1024) : null;
  return withArtifact(env, { artifact_name: job.agent_fork }, async repo => {
    let command;
    if (post && phase === 'publish') {
      try { command = receiveCommand(body); } catch { return new Response('denied', { status: 403 }); }
      if (job.agent_publish || command.old !== snapshot.agent.commitId || command.ref !== 'refs/heads/' + snapshot.agent.branch || command.next === '0'.repeat(40)) return new Response('denied', { status: 403 });
      await db.prepare("UPDATE evidence_jobs SET agent_publish='DISPATCHED',updated_at=? WHERE id=? AND agent_publish IS NULL").bind(new Date().toISOString(), id).run();
    }
    const result = await gitRequest(env, repo, job.agent_fork, advertisement ? 'info/refs?service=' + service : service, service, body, providerFetch, request.headers.get('Git-Protocol'));
    if (command) {
      const observed = (await refs(env, repo, { artifact_name: job.agent_fork }, providerFetch)).get(command.ref);
      if (observed !== command.next) throw Error('Agent publication readback differs');
      await db.prepare("UPDATE evidence_jobs SET agent_publish='APPLIED',agent_proposal=?,updated_at=? WHERE id=? AND agent_publish='DISPATCHED'").bind(command.next, new Date().toISOString(), id).run();
    }
    return new Response(result.bytes, { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store' } });
  });
}
