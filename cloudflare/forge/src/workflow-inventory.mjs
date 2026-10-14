import { digest, deny, invalid, unsupported, Fault } from './common.mjs';
import { sha } from './git.mjs';
import { nativeWorkflow, nativeWorkflowPath } from './native-workflow.mjs';
import { repositoryExecution } from './execution-policy.mjs';

export const workflowMethods = new Set(['InspectWorkflows']);
export const workflowInventoryCatalog = 'golf.native.workflow-inventory.v1';
const maximumFiles = 20, maximumBytes = 64 * 1024, executableBytes = 32768;
const listed = name => typeof name === 'string' && /^[^\\/\p{Cc}\uD800-\uDFFF]{1,251}\.ya?ml$/u.test(name);
const subset = {
  actions: 'Outside the native subset: on: pull_request, one job with runs-on: golf-native-linux and one to ten run steps; no actions, expressions, services, matrices or other keys.',
  gitlab: 'Outside the native subset: one job of script lines with an optional stage, digest-pinned image, before_script and after_script; no includes, rules or further jobs.',
};
// The settings page is an inventory on every profile; only the wording of what can run differs.
export function workflowCapability(env, executionAvailable) {
  const lists = 'Lists workflow files at the default-branch commit', triggers = ' No manual dispatch, branch-push or tag triggers.';
  if (!executionAvailable) return lists + '. None can run: pull-request test execution is not allocated on this installation.';
  if (!env.TEST_WORKFLOW_FORMAT) return lists + '. None can run: this installation executes one operator-approved Python test module on pull requests.';
  return lists + ' and marks the one operator-approved path that can run. ' + (env.TEST_WORKFLOW_FORMAT === 'actions-act' ?
    'Pull-request jobs only, on a selected customer runner pool with the pinned Actions catalog.' :
    'Pull-request jobs only: one job of shell steps, no actions, expressions, services or matrices.') + triggers;
}

// A static read of the default-branch commit. Pull-request runs read the approved path from the exact PR head instead.
export async function workflowInventory(db, env, person, row, request, method, body, artifact, executionAvailable) {
  if (method !== 'InspectWorkflows') unsupported();
  if (!['admin', 'write', 'read'].includes(row.role)) deny();
  if (body.ref !== undefined && body.ref !== '') invalid('Native workflow inspection reads the current default-branch commit.');
  const profile = env.TEST_WORKFLOW_FORMAT || '', approved = profile && nativeWorkflowPath(profile, env.TEST_WORKFLOW_PATH) ? env.TEST_WORKFLOW_PATH : '';
  const available = Boolean(executionAvailable), policy = await repositoryExecution(db, row);
  return artifact(async (repo, _info, commits) => {
    const commitId = commits[0]?.hash;
    if (!commitId) throw new Fault('failed_precondition', 412, 'The default branch has no commit to inspect.');
    const commit = sha(commitId) ? await repo.readCommit(commitId) : null;
    if (!sha(commit?.treeHash)) throw Error('Invalid default branch identity');
    const root = await repo.readTree(commit.treeHash) || [], candidates = [], diagnostics = [];
    const gitlab = root.find(entry => entry.name === '.gitlab-ci.yml');
    if (gitlab) candidates.push({ path: '.gitlab-ci.yml', entry: gitlab, format: 'gitlab' });
    const github = root.find(entry => entry.name === '.github' && entry.type === 'tree');
    const folder = github && (await repo.readTree(github.hash) || []).find(entry => entry.name === 'workflows' && entry.type === 'tree');
    const files = (folder && await repo.readTree(folder.hash) || []).filter(entry => typeof entry.name === 'string' && /\.ya?ml$/.test(entry.name));
    const unlisted = files.filter(entry => !listed(entry.name)).length;
    for (const entry of files.filter(entry => listed(entry.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) candidates.push({ path: '.github/workflows/' + entry.name, entry, format: 'actions' });
    if (unlisted) diagnostics.push({ code: 'unlisted_names', message: `${unlisted} workflow file name${unlisted === 1 ? ' is' : 's are'} outside the listable form and ${unlisted === 1 ? 'is' : 'are'} not shown.` });
    let selected = candidates.slice(0, maximumFiles);
    if (candidates.length > maximumFiles) {
      // The approved path stays visible in an overfull inventory.
      const chosen = candidates.find(item => item.path === approved);
      if (chosen && !selected.includes(chosen)) selected = [...selected.slice(0, maximumFiles - 1), chosen];
      diagnostics.push({ code: 'inventory_truncated', message: `${candidates.length} workflow files exist; ${maximumFiles} are listed.` });
    }
    if (!profile) diagnostics.push({ code: 'module_profile', message: 'None of these files can run: this installation executes one operator-approved Python test module on pull requests.' });
    else if (!approved) diagnostics.push({ code: 'approved_path_invalid', message: 'The operator-approved workflow path is not valid; no file can run.' });
    else if (!candidates.some(item => item.path === approved)) diagnostics.push({ code: 'approved_path_missing', message: `The operator-approved path ${approved} does not exist at this commit.` });
    const configurations = [];
    for (const { path, entry, format } of selected) {
      const allowed = path === approved, item = { path, blobId: '', byteSize: '0', format: format === 'gitlab' ? 'WORKFLOW_FORMAT_GITLAB_CI' : 'WORKFLOW_FORMAT_GITHUB_ACTIONS',
        state: 'WORKFLOW_INSPECTION_STATE_UNSUPPORTED', name: '', jobs: [], events: [], diagnostics: [],
        // The operator allocation and the repository switch for the one approved path; neither proves a future run will be admitted.
        manualPolicyAllowed: allowed && available && policy.manual, pushPolicyAllowed: allowed && available && env.CI_AUTO === 'true' && policy.push };
      configurations.push(item);
      if (entry.type !== 'blob' || !sha(entry.hash)) { item.diagnostics.push({ code: 'not_regular_file', message: 'Only a regular, non-executable file can be a workflow.' }); continue; }
      const blob = await repo.readBlob(entry.hash);
      if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 0) throw Error('Invalid workflow blob');
      item.blobId = entry.hash; item.byteSize = String(blob.size);
      if (blob.size > maximumBytes) { item.state = 'WORKFLOW_INSPECTION_STATE_UNSPECIFIED'; item.diagnostics.push({ code: 'file_too_large', message: 'Larger than 64 KiB; not inspected.' }); continue; }
      if (profile === 'actions-act' && format === 'actions') {
        item.state = 'WORKFLOW_INSPECTION_STATE_UNSPECIFIED';
        item.diagnostics.push({ code: 'not_inspected', message: 'This installation runs its approved path with a pinned Actions catalog on customer runners; workflow files are not statically inspected here.' });
      } else if (blob.size < 1 || blob.size > executableBytes) item.diagnostics.push({ code: 'outside_executable_size', message: 'A native workflow is between 1 byte and 32 KiB.' });
      else {
        let source = null;
        try { source = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()); }
        catch { item.state = 'WORKFLOW_INSPECTION_STATE_INVALID'; item.diagnostics.push({ code: 'not_utf8', message: 'The file is not valid UTF-8.' }); }
        if (source !== null) try {
          const plan = nativeWorkflow(format, source);
          Object.assign(item, { state: 'WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET', name: plan.name, events: format === 'actions' ? ['pull_request'] : [],
            jobs: [{ id: plan.jobId, name: '', stage: '', stepCount: plan.steps.length }] });
        } catch { item.diagnostics.push({ code: 'outside_native_subset', message: subset[format] }); }
      }
      if (!allowed && profile) item.diagnostics.push({ code: 'not_approved_path', message: 'Not the operator-approved path; it cannot run on this installation.' });
    }
    return { repositoryId: String(row.id), commitId, catalogVersion: workflowInventoryCatalog, executionAvailable: available, configurations, diagnostics,
      // An opaque observation of every ceiling reported above, not a dispatch receipt.
      policyRevision: await digest(JSON.stringify(['golf.native.workflow-policy.v1', env.TEST_POLICY_SHA256 || '', approved, available, env.CI_AUTO === 'true', policy.version, policy.manual, policy.push])), executionCatalog: '', executionEngineCommit: '' };
  }, true);
}
