import { deny, invalid, Fault } from './common.mjs';
import { repositoryAccess, settingsAuthority } from './repository-settings.mjs';

export const executionPolicyMethods = new Set(['GetExecutionPolicy', 'UpdateExecutionPolicy']);
const stale = () => { throw new Fault('failed_precondition', 412, 'Execution policy or repository access changed. Refresh before editing.'); };
const named = (value, prefix, names) => typeof value === 'string' ? names.indexOf(value.replace(prefix, '')) : value;
const fields = ['scope', 'organization', 'repository', 'scopeId', 'expectedRevision', 'expectedAuthorityRevision', 'mode', 'selectedRepositoryIds', 'manualDispatchEnabled', 'allowAllWorkflows', 'workflowPaths', 'pushAllowed'];

export function executionPolicyCapability(executionAvailable, accessLogin) {
  if (!executionAvailable) return 'Pull-request test execution is not allocated on this installation; a repository switch has nothing to govern.';
  if (!accessLogin) return 'The repository execution switch is changed only under a verified Access sign-in, which this installation does not configure.';
  return 'Administrators turn pull-request runs and automatic push tests off or on for one repository, within the operator allocation. Changes need a verified Access sign-in. Checked when a run is admitted; a run already admitted is not stopped. Agent proposals, instance and organization ceilings, repository selection and workflow path lists are not governed here.';
}
// The switch can stop a repository's CI: only a verified human Access sign-in changes it, never a bearer or service token.
const human = request => !request.headers.has('Authorization') && !request.headers.has('CF-Access-Client-Id') && !request.headers.has('CF-Access-Client-Secret') && Boolean(request.headers.get('X-Golf-Native-Access-Email'));

// No row means both kinds are enabled within the operator allocation. A row for another artifact enables nothing.
export async function repositoryExecution(db, row) {
  const stored = await db.prepare('SELECT * FROM repository_execution_policy WHERE repository_id=?').bind(row.id).first();
  if (!stored) return { version: 0, manual: true, push: true };
  const current = stored.artifact_name === row.artifact_name;
  return { version: stored.version, manual: current && stored.manual === 1, push: current && stored.push === 1, foreign: !current };
}

export async function executionPolicy(db, env, person, row, request, method, body) {
  if (!executionPolicyMethods.has(method) || named(body.scope, 'EXECUTION_SCOPE_', ['UNSPECIFIED', 'INSTANCE', 'ORGANIZATION', 'REPOSITORY']) !== 3 || body.organization)
    throw new Fault('unimplemented', 501, 'This installation has a repository switch only; instance and organization execution ceilings are operator-managed.');
  if (!['admin', 'write', 'read'].includes(row.role)) deny();
  const { access } = await repositoryAccess(db, env, person, row), current = await repositoryExecution(db, row);
  if (method === 'UpdateExecutionPolicy') {
    if (!human(request) || row.role !== 'admin' || body.scopeId !== String(row.id)) deny();
    const mode = named(body.mode, 'EXECUTION_MODE_', ['UNSPECIFIED', 'DISABLED', 'ALL', 'SELECTED']), manual = body.manualDispatchEnabled ?? false, push = body.pushAllowed ?? false;
    if (Object.keys(body).some(key => !fields.includes(key)) || ![1, 2].includes(mode) || typeof manual !== 'boolean' || typeof push !== 'boolean' || body.allowAllWorkflows !== true ||
        [body.selectedRepositoryIds, body.workflowPaths].some(list => list !== undefined && (!Array.isArray(list) || list.length)))
      invalid('This installation has one switch per repository for pull-request runs and automatic push tests. Repository selection and workflow path lists are operator-managed.');
    if ((mode === 2) !== (manual || push)) invalid('Allow at least one kind of run, or disable both.');
    if (typeof body.expectedRevision !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(body.expectedRevision) || typeof body.expectedAuthorityRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedAuthorityRevision)) invalid('Use the observed policy and authority revisions.');
    if (current.foreign) throw new Fault('failed_precondition', 412, 'Repository execution policy identity changed.');
    if (body.expectedRevision !== String(current.version) || body.expectedAuthorityRevision !== access.revision) stale();
    // Authority and the observed version are rechecked in the same statement as the write.
    const authority = settingsAuthority(person, row);
    const saved = await db.prepare(`INSERT INTO repository_execution_policy(repository_id,artifact_name,version,manual,push,updated_by,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE ${authority.sql} AND COALESCE((SELECT version FROM repository_execution_policy WHERE repository_id=?),0)=?
      ON CONFLICT(repository_id) DO UPDATE SET version=excluded.version,manual=excluded.manual,push=excluded.push,updated_by=excluded.updated_by,updated_at=excluded.updated_at
      WHERE repository_execution_policy.version=? AND repository_execution_policy.artifact_name=excluded.artifact_name`)
      .bind(row.id, row.artifact_name, current.version + 1, manual ? 1 : 0, push ? 1 : 0, person.id, new Date().toISOString(), ...authority.values, row.id, current.version, current.version).run();
    if (saved.meta.changes !== 1) stale();
    return executionPolicy(db, env, person, row, request, 'GetExecutionPolicy', { scope: 3 });
  }
  // Admission is the only enforcement point, so the revocation epoch never advances: no admitted run is revoked.
  return { policy: { scope: 'EXECUTION_SCOPE_REPOSITORY', scopeId: String(row.id), ownerId: String(row.workspace_id), mode: current.manual || current.push ? 'EXECUTION_MODE_ALL' : 'EXECUTION_MODE_DISABLED',
    selectedRepositoryIds: [], manualDispatchEnabled: current.manual, allowAllWorkflows: true, workflowPaths: [], revision: String(current.version), revocationEpoch: '0',
    canEdit: row.role === 'admin' && human(request), authorityRevision: access.revision, pushAllowed: current.push } };
}
