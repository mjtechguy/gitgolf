export const testTerminal = new Set(['PASSED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'LOST']);
export const nativeTestContract = 'golf.native.pr-test.v1';
export { nativeWorkflowContract, nativeActionsContract, nativeActionsBuildContract } from './native-workflow.mjs';
import { nativeWorkflowContract, nativeActionsContract, nativeActionsBuildContract, nativeWorkflowPath } from './native-workflow.mjs';
export const testModuleOK = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,8}$/.test(value) && value.length <= 128;
export const executionDiagnostic = error => String(error?.message || 'Native execution failed')
  .replace(/golf_native_[A-Za-z0-9_-]+|art_v1_[^\s"']+|cfcr\.[A-Za-z0-9_-]+\.[a-f0-9]{64}|(?:Bearer|Basic)\s+[^\s"']+|https?:\/\/[^\s"']+/gi, '[private]').slice(0, 512);
// One approved source per installation, or the hosted Actions shell workflow beside a module:
// PR runs then use the workflow and the module only tests agent proposals.
export function testProfile(tests) {
  const workflow = tests?.workflow, module = tests?.module;
  if (workflow !== undefined && (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || Object.keys(workflow).some(key => !['format', 'path'].includes(key)) || !nativeWorkflowPath(workflow.format, workflow.path)) ||
      (workflow === undefined || module !== undefined) && !testModuleOK(module) || workflow && module !== undefined && workflow.format !== 'actions') throw Error('Invalid approved native test source');
  return { workflow, module };
}
export function testPolicy(env) {
  return env.TEST_EXECUTION_ENABLED === 'true' && (env.TEST_WORKFLOW_FORMAT ? nativeWorkflowPath(env.TEST_WORKFLOW_FORMAT, env.TEST_WORKFLOW_PATH) && (env.TEST_MODULE === undefined || env.TEST_WORKFLOW_FORMAT === 'actions' && testModuleOK(env.TEST_MODULE)) : testModuleOK(env.TEST_MODULE)) &&
    /^[a-f0-9]{64}$/.test(env.TEST_POLICY_SHA256 || '') && Boolean(env.testTasks);
}
export function testResult(value, jobId, source) {
  const workflow = source?.contract === nativeWorkflowContract || source?.contract === nativeActionsContract || source?.contract === nativeActionsBuildContract;
  if (!value || source.contract !== undefined && ![nativeTestContract, nativeWorkflowContract, nativeActionsContract, nativeActionsBuildContract].includes(source.contract) || value.contract !== source.contract || value.jobId !== jobId || value.commitId !== source.commitId || value.treeId !== source.treeId ||
      !testTerminal.has(value.state) || value.cleanup !== 'destroyed' || (workflow ? !/^[a-f0-9]{64}$/.test(source.workflowSha256 || '') || value.workflowSha256 !== source.workflowSha256 : value.module !== source.module) || value.policySha256 !== source.policySha256 ||
      !Number.isSafeInteger(value.finishedAt) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' ||
      !Number.isSafeInteger(value.deniedRequests) || value.deniedRequests < 0 || value.deniedRequests > 1000000 ||
      new TextEncoder().encode(value.stdout + value.stderr).length > 65536 ||
      value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255) ||
      value.state === 'PASSED' && value.exitCode !== 0 || value.state === 'FAILED' && (value.exitCode === null || value.exitCode === 0) ||
      value.state === 'LOST' && (!['admitted', 'dispatch', 'start', 'clone', 'test', 'terminal'].includes(value.failureStage) || typeof value.diagnostic !== 'string' || value.diagnostic.length > 512)) throw Error('Invalid test execution result');
  if (source.contract === nativeActionsBuildContract ?
      value.state === 'PASSED' && !value.build || value.state !== 'PASSED' && value.build !== undefined || value.build !== undefined &&
        (!value.build || Object.keys(value.build).sort().join(',') !== 'bytes,digest,dockerfile,sourceCommit' || value.build.dockerfile !== 'Dockerfile' || value.build.sourceCommit !== source.commitId || !/^sha256:[a-f0-9]{64}$/.test(value.build.digest) || !Number.isSafeInteger(value.build.bytes) || value.build.bytes < 1 || value.build.bytes > (32<<20)) :
      value.build !== undefined) throw Error('Invalid socketless build receipt');
  if(value.image && (!source.registry || value.state!=='PASSED' || value.image.registry!==source.registry.origin || value.image.repository!==source.registry.name || value.image.tag!=='ci-'+jobId || value.image.commitId!==source.commitId || !/^sha256:[a-f0-9]{64}$/.test(value.image.digest||'') || Object.keys(value.image).some(k=>!['registry','repository','tag','digest','commitId'].includes(k)))) throw Error('Invalid job image receipt');
  return { ...(source.contract ? { contract: source.contract } : {}), jobId, commitId: source.commitId, treeId: source.treeId,
    ...(workflow ? { workflowSha256: source.workflowSha256 } : { module: source.module }), policySha256: source.policySha256,
    ...(value.image?{image:value.image}:{}), ...(value.build?{build:value.build}:{}),
    state: value.state, cleanup: 'destroyed', deniedRequests: value.deniedRequests, exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr, finishedAt: value.finishedAt,
    ...(value.state === 'LOST' ? { failureStage: value.failureStage, diagnostic: value.diagnostic } : {}) };
}
