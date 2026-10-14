import { digest, deny, invalid, Fault, uuidOK } from './common.mjs';
import { ownerSlug } from './owners.mjs';
import { sha, validRef } from './git.mjs';
import { repositoryAccess } from './repository-settings.mjs';
import { nativeWorkflowContract, nativeWorkflowPath, nativeWorkflowSource } from './native-workflow.mjs';
import { sealingKey, seal, open } from './sealed.mjs';

export const executionValueMethods = new Set(['ListRepositoryExecutionValues', 'SaveRepositoryExecutionValue', 'DeleteRepositoryExecutionValue', 'GetRepositoryExecutionVariable',
  'SaveRepositoryExecutionBinding', 'DeleteRepositoryExecutionBinding', 'GetRepositoryExecutionValueOperation']);
const text = new TextEncoder(), now = () => new Date().toISOString();
const maximumValues = 64, maximumBindings = 20, maximumBytes = 8192, maximumEnvironment = 64 * 1024, retainedVersions = 256;
const changed = () => { throw new Fault('aborted', 409, 'Execution values or operation intent changed. Refresh and inspect the original operation.'); };
const canonical = (value, zero) => typeof value === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(value) && (zero || value !== '0');
const member = (value, names) => typeof value === 'string' ? names.indexOf(value) : value ?? 0;

// Process and controller authority, never repository values. The portable list, plus what GitLab-format jobs and the hosted bash steps read from their environment.
const reservedNames = new Set(['PATH', 'HOME', 'ENV', 'BASH_ENV', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'IFS', 'CDPATH', 'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME', 'CI', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME',
  'RUBYOPT', 'PERL5OPT', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'TRACE', 'SHELLOPTS', 'BASHOPTS', 'PS4']);
const reservedPrefixes = ['GOLF_', 'GITHUB_', 'ACTIONS_', 'RUNNER_', 'ACT_', 'DOCKER_', 'LD_', 'DYLD_', 'XDG_', 'GIT_', 'SSH_', 'NODE_', 'BASH_', 'PYTHON_', 'SYSTEMD_', 'CI_', 'FF_', 'GITLAB_'];
export const executionValueName = name => typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && !reservedNames.has(name) && !reservedPrefixes.some(prefix => name.startsWith(prefix));
export function executionValueBody(value, secret) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]/u.test(value)) return false;
  const bytes = text.encode(value).length;
  return bytes >= (secret ? 8 : 1) && bytes <= maximumBytes;
}

// Values are released only to the Cloudflare-hosted Actions shell lane, so an installation without that profile cannot honestly offer them.
export function executionValueState(env) {
  if (env.TEST_WORKFLOW_FORMAT !== 'actions' || !nativeWorkflowPath('actions', env.TEST_WORKFLOW_PATH)) return { ready: false, reason: 'Repository values need an operator-approved Actions workflow profile; this installation ' +
    (env.TEST_WORKFLOW_FORMAT === 'gitlab' ? 'runs an approved GitLab CI workflow' : env.TEST_WORKFLOW_FORMAT === 'actions-act' ? 'runs pinned Actions jobs on customer runners' : env.TEST_MODULE ? 'runs an approved Python test module' : 'has no container test allocation') + '.' };
  if (!env.EXECUTION_VALUE_KEY?.get) return { ready: false, reason: 'Configure a dedicated Secrets Store encryption key for repository values.' };
  return { ready: true, reason: '' };
}
// Storage alone is not the feature: the page opens only once approved values reach a job.
export function executionValueCapability(env) {
  const state = executionValueState(env);
  return { id: 'settings.repository-secrets', label: 'Secrets and variables', state: 'CAPABILITY_STATE_DISABLED',
    reason: state.reason || 'Encrypted repository values and exact-commit approvals can be stored, but no job receives them on this installation yet.' };
}
export function executionValueBindings(settings) {
  if (!settings.execution_values) return {};
  const key = settings.execution_values.key, other = [settings.webhooks?.key, settings.apps?.provisioner, settings.apps?.policy?.secret, settings.registry?.apiToken, settings.operations?.analytics_secret];
  if (Object.keys(settings.execution_values).join(',') !== 'key' || !key || Object.keys(key).some(k => !['store', 'name'].includes(k)) || !/^[a-f0-9]{32}$/.test(key.store || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(key.name || '') ||
      other.some(used => used?.store === key.store && used.name === key.name)) throw Error('Repository values need their own Secrets Store encryption key reference');
  return { EXECUTION_VALUE_KEY: { type: 'secrets-store-secret', storeId: key.store, secretName: key.name } };
}

const additional = (env, row, value, version, bytes) => ['golf.native.execution-value.v1', env.PUBLIC_ORIGIN, row.id, row.artifact_name, value.id, version, value.name, value.kind, bytes];
const encryptionKey = env => sealingKey(env.EXECUTION_VALUE_KEY, 'Repository value');
// Failures here carry no stored or submitted text: callers surface one fixed message.
async function openVersion(db, env, row, value, version) {
  const stored = await db.prepare('SELECT * FROM execution_value_versions WHERE id=? AND version=?').bind(value.id, version).first(), { key, id } = await encryptionKey(env);
  if (!stored || stored.key_id !== id) throw Error('Repository value unavailable');
  let plain;
  try { plain = await open(key, additional(env, row, value, version, stored.value_bytes), stored.encrypted); } catch { throw Error('Repository value unavailable'); }
  if (text.encode(plain).length !== stored.value_bytes || !executionValueBody(plain, value.kind === 'secret')) throw Error('Repository value unavailable');
  return plain;
}
function same(left, right) {
  const a = text.encode(left), b = text.encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i % (b.length || 1)];
  return difference === 0;
}

// The approver's authority is re-read wherever an approval is shown or used; a stored approval is never ongoing consent.
const sponsorAuthority = `EXISTS(SELECT 1 FROM users u JOIN grants g ON g.user_id=u.id
 JOIN repositories r ON r.id=g.repository_id LEFT JOIN native_identity_versions v ON v.user_id=u.id
 LEFT JOIN collaborator_versions c ON c.repository_id=r.id AND c.user_id=u.id
 WHERE u.id=b.sponsor_id AND u.active=1 AND g.role='admin' AND r.id=b.repository_id AND r.state='ACTIVE'
 AND r.artifact_name=b.artifact_name AND COALESCE(v.version,0)=b.identity_version AND COALESCE(c.generation,0)=b.grant_generation)`;
const bindingSelect = `SELECT b.*,${sponsorAuthority} AS authorized FROM execution_bindings b`;
// Every write repeats the actor's current administration and the observed broker revision inside its own statement.
function writeGuard(person, row, revision) {
  return { sql: `EXISTS(SELECT 1 FROM repositories r JOIN grants g ON g.repository_id=r.id JOIN users u ON u.id=g.user_id
    LEFT JOIN native_identity_versions v ON v.user_id=u.id LEFT JOIN repository_access_versions a ON a.repository_id=r.id
    WHERE r.id=? AND r.artifact_name=? AND r.state='ACTIVE' AND g.user_id=? AND g.role='admin' AND u.active=1 AND COALESCE(v.version,0)=? AND COALESCE(a.version,0)=?)
    AND COALESCE((SELECT revision FROM execution_value_brokers WHERE repository_id=?),0)=?`,
    values: [row.id, row.artifact_name, person.id, person.identity_version || 0, row.access_version || 0, row.id, revision] };
}
const kinds = ['REPOSITORY_EXECUTION_VALUE_KIND_UNSPECIFIED', 'REPOSITORY_EXECUTION_VALUE_KIND_SECRET', 'REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE'];
const wireValue = v => ({ id: v.id, name: v.name, kind: v.kind === 'secret' ? kinds[1] : kinds[2], version: String(v.version), deleted: !!v.deleted, createdAt: v.created_at, updatedAt: v.updated_at });
const wireBinding = b => ({ id: b.id, version: String(b.version), workflowPath: b.workflow_path, commitId: b.commit_id, workflowBlobId: b.blob_id, sourceSha256: b.source_sha256, engineCatalog: b.engine_catalog,
  event: 'WORKFLOW_RUN_ORIGIN_PUSH', eventRef: b.event_ref, values: JSON.parse(b.value_refs).map(ref => ({ id: ref.id, version: String(ref.version), scope: 'EXECUTION_VALUE_SCOPE_REPOSITORY' })),
  deleted: !!b.deleted, expiresAt: b.expires_at, createdAt: b.created_at, updatedAt: b.updated_at, approvalState: b.authorized ? 'requires_current_authority' : 'authority_unavailable' });
// One identity for what an approval covers: the commit, its tree and the compiled plan of the approved workflow file.
export const executionSource = (commitId, treeId, workflowSha256) => digest(JSON.stringify(['golf.native.execution-source.v1', commitId, treeId, workflowSha256]));

export async function repositoryExecutionValues(db, env, person, row, request, method, body, artifact) {
  const state = executionValueState(env), target = body.target;
  if (!state.ready) throw new Fault('failed_precondition', 412, state.reason);
  // A verified Access sign-in by a current administrator; bearer, Git and service credentials never manage values.
  if (request.headers.has('Authorization') || request.headers.has('CF-Access-Client-Id') || request.headers.has('CF-Access-Client-Secret') || !request.headers.get('X-Golf-Native-Access-Email') ||
      row.role !== 'admin' || target?.repositoryId !== String(row.id) || target.ownerId !== String(row.workspace_id) || target.repository?.owner !== ownerSlug(row, env) || target.repository.name !== row.name) deny();
  if (target.accessRevision !== (await repositoryAccess(db, env, person, row)).access.revision) throw new Fault('failed_precondition', 412, 'Repository access changed. Refresh before managing values.');
  const broker = async () => (await db.prepare('SELECT revision FROM execution_value_brokers WHERE repository_id=?').bind(row.id).first())?.revision || 0;
  const stored = id => db.prepare('SELECT * FROM execution_values WHERE id=? AND repository_id=? AND artifact_name=?').bind(id, row.id, row.artifact_name).first();
  if (method === 'ListRepositoryExecutionValues') {
    const { results: values } = await db.prepare('SELECT * FROM execution_values WHERE repository_id=? AND artifact_name=? ORDER BY name,id LIMIT ?').bind(row.id, row.artifact_name, maximumValues + 1).all();
    const { results: bindings } = await db.prepare(bindingSelect + ' WHERE b.repository_id=? AND b.artifact_name=? ORDER BY b.created_at,b.id LIMIT ?').bind(row.id, row.artifact_name, maximumBindings + 1).all();
    if (values.length > maximumValues || bindings.length > maximumBindings) throw Error('Execution value inventory exceeds its bound');
    return { target, brokerRevision: String(await broker()), values: values.map(wireValue), bindings: bindings.map(wireBinding), consumerProfile: 'golf.repository-env.v1', maximumValues, maximumBindings, inheritedValues: [] };
  }
  if (method === 'GetRepositoryExecutionVariable') {
    if (!uuidOK(body.id) || !canonical(body.version)) invalid('Select the exact current variable version.');
    const value = await stored(body.id);
    // Secrets have no read path at all.
    if (!value || value.kind !== 'variable' || value.deleted || String(value.version) !== body.version) deny();
    return { target, variable: wireValue(value), value: await openVersion(db, env, row, value, value.version) };
  }
  const receipt = (operation, replayed) => ({ target, operationId: operation.operation_id, action: operation.action, itemId: operation.item_id, acceptedVersion: String(operation.accepted_version),
    acceptedBrokerRevision: String(operation.accepted_broker_revision), replayed, committedAt: operation.created_at });
  if (!uuidOK(body.operationId)) invalid('Provide canonical operation and item UUIDs.');
  const original = await db.prepare('SELECT * FROM execution_value_operations WHERE operation_id=?').bind(body.operationId).first();
  if (original && (original.actor_id !== person.id || original.repository_id !== row.id)) deny();
  if (method === 'GetRepositoryExecutionValueOperation') {
    if (!original) deny();
    return { operation: receipt(original, false) };
  }
  const action = { SaveRepositoryExecutionValue: 'save_value', DeleteRepositoryExecutionValue: 'delete_value', SaveRepositoryExecutionBinding: 'save_binding', DeleteRepositoryExecutionBinding: 'delete_binding' }[method];
  if (!uuidOK(body.id) || !canonical(body.expectedVersion, true) || !canonical(body.expectedBrokerRevision, true)) invalid('Provide canonical operation and item UUIDs with the observed versions.');
  const version = Number(body.expectedVersion), revision = Number(body.expectedBrokerRevision), time = now(), statements = [];
  let fingerprint, guard;
  // Returns false for a confirmed replay of the original request; anything else under a used operation ID is refused.
  const fresh = async (fields, plain) => {
    fingerprint = await digest(JSON.stringify([action, row.id, row.artifact_name, person.id, body.id, body.expectedVersion, body.expectedBrokerRevision, ...fields]));
    if (original) {
      if (original.action !== action || original.item_id !== body.id || original.input_hash !== fingerprint) changed();
      // The receipt holds no digest of a secret; a replay must reproduce the exact text that was sealed.
      const sealed = plain === undefined ? null : await stored(body.id);
      if (plain !== undefined && (!sealed || !same(await openVersion(db, env, row, sealed, original.accepted_version), plain))) changed();
      return false;
    }
    if (await broker() !== revision) changed();
    guard = writeGuard(person, row, revision);
    return true;
  };
  if (action === 'save_value') {
    const kind = ['', 'secret', 'variable'][member(body.kind, kinds)];
    if (!kind || !executionValueName(body.name) || !executionValueBody(body.value, kind === 'secret')) invalid('Provide a safe uppercase name and a supported bounded single-line value.');
    if (!await fresh([body.name, kind], body.value)) return { operation: receipt(original, true) };
    const current = await stored(body.id), bytes = text.encode(body.value).length;
    if (current ? current.version !== version || current.name !== body.name || current.kind !== kind : version !== 0) changed();
    const usage = await db.prepare(`SELECT COUNT(*) AS names,COALESCE(SUM(CASE WHEN deleted=0 AND id<>? THEN value_bytes ELSE 0 END),0) AS active,COALESCE(SUM(CASE WHEN name=? AND id<>? THEN 1 ELSE 0 END),0) AS named,
      (SELECT COUNT(*) FROM execution_value_versions h JOIN execution_values o ON o.id=h.id WHERE o.repository_id=? AND o.artifact_name=?) AS history FROM execution_values WHERE repository_id=? AND artifact_name=?`)
      .bind(body.id, body.name, body.id, row.id, row.artifact_name, row.id, row.artifact_name).first();
    if (usage.named) invalid('A value with this name already exists in the repository.');
    if (!current && usage.names >= maximumValues || usage.history >= retainedVersions || usage.active + bytes > maximumEnvironment) invalid('Repository execution value retention or active-value quota reached.');
    const { key, id: keyId } = await encryptionKey(env);
    const encrypted = await seal(key, additional(env, row, { id: body.id, name: body.name, kind }, version + 1, bytes), body.value);
    statements.push(db.prepare(`INSERT INTO execution_values(id,repository_id,artifact_name,name,kind,version,deleted,value_bytes,created_at,updated_at)
      SELECT ?,?,?,?,?,?,0,?,?,? WHERE ${guard.sql} AND (EXISTS(SELECT 1 FROM execution_values WHERE id=? AND repository_id=? AND version=?) OR (?=0 AND NOT EXISTS(SELECT 1 FROM execution_values WHERE id=?)))
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,deleted=0,value_bytes=excluded.value_bytes,updated_at=excluded.updated_at WHERE execution_values.repository_id=excluded.repository_id AND execution_values.version=?`)
      .bind(body.id, row.id, row.artifact_name, body.name, kind, version + 1, bytes, time, time, ...guard.values, body.id, row.id, version, version, body.id, version),
    db.prepare('INSERT INTO execution_value_versions(id,version,value_bytes,encrypted,key_id,created_at) SELECT ?,?,?,?,?,? WHERE changes()=1').bind(body.id, version + 1, bytes, encrypted, keyId, time));
  } else if (action === 'delete_value') {
    if (!await fresh([])) return { operation: receipt(original, true) };
    // Removal consumes a version and stores no second ciphertext; earlier versions stay sealed for receipts.
    statements.push(db.prepare(`UPDATE execution_values SET version=version+1,deleted=1,updated_at=? WHERE id=? AND repository_id=? AND artifact_name=? AND version=? AND deleted=0 AND ${guard.sql}`)
      .bind(time, body.id, row.id, row.artifact_name, version, ...guard.values));
  } else if (action === 'save_binding') {
    if ((Array.isArray(body.inputs) ? body.inputs.length : body.inputs !== undefined) || body.inputContract || body.schemaSha256 || body.submittedSha256 || body.effectiveSha256) invalid('Typed input approvals are not available on Cloudflare native.');
    // The contract has no pull-request origin yet: native stores the push origin with the pull request's head branch ref.
    if (member(body.event, ['WORKFLOW_RUN_ORIGIN_UNSPECIFIED', 'WORKFLOW_RUN_ORIGIN_MANUAL', 'WORKFLOW_RUN_ORIGIN_PUSH']) !== 2 || typeof body.eventRef !== 'string' || !body.eventRef.startsWith('refs/heads/') || !validRef(body.eventRef))
      invalid('Native approvals cover pull-request jobs: choose the pull request head branch as refs/heads/NAME.');
    if (body.workflowPath !== env.TEST_WORKFLOW_PATH) invalid('Approve the operator-approved workflow path of this installation.');
    const expires = typeof body.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.expiresAt) ? Date.parse(body.expiresAt) : NaN;
    if (!(expires > Date.now() + 60000) || expires > Date.now() + 86400000) invalid('Select an approval expiry between one minute and 24 hours.');
    const refs = body.values;
    if (!sha(body.commitId) || body.workflowBlobId !== undefined && body.workflowBlobId !== '' && !sha(body.workflowBlobId) || !Array.isArray(refs) || refs.length < 1 || refs.length > maximumValues || new Set(refs.map(ref => ref?.id)).size !== refs.length ||
        refs.some(ref => !ref || !uuidOK(ref.id) || !canonical(ref.version) || ![0, 1].includes(member(ref.scope, ['EXECUTION_VALUE_SCOPE_UNSPECIFIED', 'EXECUTION_VALUE_SCOPE_REPOSITORY', 'EXECUTION_VALUE_SCOPE_ORGANIZATION'])) || ref.organizationId))
      invalid('Select an exact commit and distinct current repository value versions.');
    const selected = refs.map(ref => ({ id: ref.id, version: Number(ref.version) })).sort((a, b) => a.id < b.id ? -1 : 1), expiresAt = new Date(expires).toISOString();
    if (!await fresh([body.workflowPath, body.commitId, body.workflowBlobId || '', body.eventRef, expiresAt, selected])) return { operation: receipt(original, true) };
    const approvals = await db.prepare('SELECT COUNT(*) AS total,MAX(CASE WHEN id=? THEN version END) AS version FROM execution_bindings WHERE repository_id=? AND artifact_name=?').bind(body.id, row.id, row.artifact_name).first();
    if ((approvals.version || 0) !== version) changed();
    if (!version && approvals.total >= maximumBindings) invalid('Source approval retention quota reached.');
    const source = await artifact(async repo => {
      const commit = await repo.readCommit(body.commitId);
      if (!sha(commit?.treeHash)) invalid('The approved commit is not in this repository.');
      try { return { treeId: commit.treeHash, workflow: await nativeWorkflowSource(repo, commit.treeHash, 'actions', body.workflowPath) }; }
      catch (error) {
        if (/^(Unsupported native|Native workflow)/.test(error.message)) invalid('The approved commit needs a supported workflow at the approved path.');
        throw error;
      }
    });
    if (body.workflowBlobId && body.workflowBlobId !== source.workflow.blobId) changed();
    const { results: values } = await db.prepare(`SELECT v.id,v.value_bytes FROM execution_values v JOIN json_each(?) s ON json_extract(s.value,'$.id')=v.id
      WHERE v.repository_id=? AND v.artifact_name=? AND v.deleted=0 AND v.version=json_extract(s.value,'$.version')`).bind(JSON.stringify(selected), row.id, row.artifact_name).all();
    if (values.length !== selected.length) changed();
    if (values.reduce((total, value) => total + value.value_bytes, 0) > maximumEnvironment) invalid('Approved value aggregate exceeds its bound.');
    statements.push(db.prepare(`INSERT INTO execution_bindings(id,repository_id,artifact_name,version,deleted,workflow_path,commit_id,blob_id,source_sha256,engine_catalog,event_ref,value_refs,sponsor_id,identity_version,grant_generation,expires_at,created_at,updated_at)
      SELECT ?,?,?,?,0,?,?,?,?,?,?,?,?,?,COALESCE((SELECT generation FROM collaborator_versions WHERE repository_id=? AND user_id=?),0),?,?,? WHERE ${guard.sql}
      AND (EXISTS(SELECT 1 FROM execution_bindings WHERE id=? AND repository_id=? AND version=?) OR (?=0 AND NOT EXISTS(SELECT 1 FROM execution_bindings WHERE id=?) AND (SELECT COUNT(*) FROM execution_bindings WHERE repository_id=?)<?))
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,deleted=0,workflow_path=excluded.workflow_path,commit_id=excluded.commit_id,blob_id=excluded.blob_id,source_sha256=excluded.source_sha256,engine_catalog=excluded.engine_catalog,event_ref=excluded.event_ref,
        value_refs=excluded.value_refs,sponsor_id=excluded.sponsor_id,identity_version=excluded.identity_version,grant_generation=excluded.grant_generation,expires_at=excluded.expires_at,updated_at=excluded.updated_at
        WHERE execution_bindings.repository_id=excluded.repository_id AND execution_bindings.version=?`)
      .bind(body.id, row.id, row.artifact_name, version + 1, body.workflowPath, body.commitId, source.workflow.blobId, await executionSource(body.commitId, source.treeId, await digest(JSON.stringify(source.workflow))), nativeWorkflowContract,
        body.eventRef, JSON.stringify(selected), person.id, person.identity_version || 0, row.id, person.id, expiresAt, time, time, ...guard.values, body.id, row.id, version, version, body.id, row.id, maximumBindings, version));
  } else {
    if (!await fresh([])) return { operation: receipt(original, true) };
    statements.push(db.prepare(`UPDATE execution_bindings SET version=version+1,deleted=1,updated_at=? WHERE id=? AND repository_id=? AND artifact_name=? AND version=? AND deleted=0 AND ${guard.sql}`)
      .bind(time, body.id, row.id, row.artifact_name, version, ...guard.values));
  }
  // The item write carries every guard; the revision and the receipt follow only when it changed exactly one row.
  statements.push(db.prepare(`INSERT INTO execution_value_brokers(repository_id,artifact_name,revision) SELECT ?,?,1 WHERE changes()=1
      ON CONFLICT(repository_id) DO UPDATE SET revision=revision+1`).bind(row.id, row.artifact_name),
    db.prepare(`INSERT INTO execution_value_operations(operation_id,repository_id,actor_id,action,item_id,accepted_version,accepted_broker_revision,input_hash,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1`)
      .bind(body.operationId, row.id, person.id, action, body.id, version + 1, revision + 1, fingerprint, time));
  const results = await db.batch(statements);
  if (!results.at(-1).meta.changes) changed();
  return { operation: receipt(await db.prepare('SELECT * FROM execution_value_operations WHERE operation_id=?').bind(body.operationId).first(), false) };
}
