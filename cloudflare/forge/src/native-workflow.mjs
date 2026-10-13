/*!
 * yaml Copyright Eemeli Aro <eemeli@gmail.com>
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 */
import { parseDocument, isAlias, isCollection } from '../../agents/node_modules/yaml/browser/index.js';
import { sha } from './git.mjs';

export const nativeWorkflowContract = 'golf.native.workflow-shell.v1';
export const nativeActionsContract = 'golf.native.actions-act.v1';
export const nativeActionsBuildContract = 'golf.native.actions-act-build.v1';
export const nativeActionsCatalog = 'golf.workflow.act.v0.2.89.linux.v1';
export const nativeWorkflowPath = (format, path) => ['actions','actions-act'].includes(format) ?
  typeof path === 'string' && /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.ya?ml$/.test(path) :
  format === 'gitlab' && path === '.gitlab-ci.yml';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const label = value => typeof value === 'string' && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const script = value => typeof value === 'string' && value.trim() && !value.includes('${{') && !value.includes('\0') &&
  new TextEncoder().encode(value).length <= 8192;
const scripts = value => typeof value === 'string' ? [value] : Array.isArray(value) && value.length <= 10 ? value : null;
const pinnedImage = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._/-]{0,127}:[a-z0-9][a-z0-9._-]{0,63}@sha256:[a-f0-9]{64}$/.test(value);

// Only the declared syntax is executable. A partial parse must never become a job.
export function nativeWorkflow(format, source) {
  if (!['actions', 'gitlab'].includes(format) || typeof source !== 'string' || new TextEncoder().encode(source).length > 32768) throw Error('Unsupported native workflow');
  const document = parseDocument(source, { uniqueKeys: true, maxAliasCount: 0, strict: true });
  const nodes = [document.contents];
  if (document.errors.length || !document.contents) throw Error('Unsupported native workflow');
  for (let count = 0; nodes.length; count++) {
    if (count > 4096) throw Error('Unsupported native workflow');
    const node = nodes.pop();
    if (isAlias(node) || node?.anchor || node?.tag && !['tag:yaml.org,2002:map', 'tag:yaml.org,2002:seq', 'tag:yaml.org,2002:str'].includes(node.tag)) throw Error('Unsupported native workflow');
    if (isCollection(node)) for (const item of node.items) {
      if (item && Object.hasOwn(item, 'key')) nodes.push(item.key, item.value);
      else nodes.push(item);
    }
  }
  const root = document.toJS();
  if (!object(root)) throw Error('Unsupported native workflow');
  if (format === 'actions') {
    if (!fields(root, ['name', 'on', 'jobs']) || root.on !== 'pull_request' || root.name !== undefined && !label(root.name) || !object(root.jobs) || Object.keys(root.jobs).length !== 1) throw Error('Unsupported native Actions workflow');
    const [jobId] = Object.keys(root.jobs), job = root.jobs[jobId];
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(jobId) || !fields(job, ['name', 'runs-on', 'steps']) || job['runs-on'] !== 'golf-native-linux' || job.name !== undefined && !label(job.name) || !Array.isArray(job.steps) || job.steps.length < 1 || job.steps.length > 10) throw Error('Unsupported native Actions workflow');
    const steps = job.steps.map(step => {
      if (!fields(step, ['name', 'run', 'shell']) || !script(step.run) || step.name !== undefined && !label(step.name) || step.shell !== undefined && !['sh', 'bash'].includes(step.shell)) throw Error('Unsupported native Actions step');
      return { name: step.name || '', run: step.run, shell: step.shell || 'default' };
    });
    if (steps.reduce((size, step) => size + new TextEncoder().encode(step.run).length, 0) > 16384) throw Error('Native workflow script limit');
    return { format, name: root.name || '', jobId, steps };
  }
  const names = Object.keys(root).filter(key => key !== 'stages');
  if (names.length !== 1 || root.stages !== undefined && (!Array.isArray(root.stages) || root.stages.length !== 1 || typeof root.stages[0] !== 'string')) throw Error('Unsupported native GitLab workflow');
  const [jobId] = names, job = root[jobId];
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(jobId) || !fields(job, ['stage', 'image', 'before_script', 'script', 'after_script']) || job.stage !== undefined && (typeof job.stage !== 'string' || root.stages && job.stage !== root.stages[0]) || job.image !== undefined && !pinnedImage(job.image)) throw Error('Unsupported native GitLab job');
  const before = job.before_script === undefined ? [] : scripts(job.before_script), main = scripts(job.script), after = job.after_script === undefined ? [] : scripts(job.after_script);
  if (!before || !main?.length || !after || before.length + main.length + after.length > 10 || ![...before, ...main, ...after].every(script)) throw Error('Unsupported native GitLab script');
  const run = [...before, ...main].join('\n'), cleanup = after.join('\n');
  if (new TextEncoder().encode(run + cleanup).length > 16384) throw Error('Native workflow script limit');
  return { format, name: '', jobId, steps: [{ name: jobId, run, shell: 'sh' }], ...(job.image ? { image: job.image } : {}), ...(cleanup ? { afterScript: cleanup } : {}) };
}

export function nativeWorkflowPlanOK(plan) {
  if (fields(plan, ['format','catalog']) && plan.format === 'actions-act') return plan.catalog === nativeActionsCatalog;
  return fields(plan, ['format', 'name', 'jobId', 'steps', 'image', 'afterScript']) && ['actions', 'gitlab'].includes(plan.format) && label(plan.name) &&
    typeof plan.jobId === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(plan.jobId) &&
    Array.isArray(plan.steps) && plan.steps.length >= 1 && plan.steps.length <= (plan.format === 'actions' ? 10 : 1) &&
    plan.steps.every(step => fields(step, ['name', 'run', 'shell']) && label(step.name) && script(step.run) && ['default', 'sh', 'bash'].includes(step.shell)) &&
    (plan.format === 'actions' ? plan.afterScript === undefined && plan.image === undefined : plan.steps[0].shell === 'sh' && (plan.image === undefined || pinnedImage(plan.image)) && (plan.afterScript === undefined || script(plan.afterScript))) &&
    new TextEncoder().encode(plan.steps.map(step => step.run).join('') + (plan.afterScript || '')).length <= 16384;
}

export async function nativeWorkflowSource(repo, treeId, format, path) {
  if (!sha(treeId) || !nativeWorkflowPath(format, path)) throw Error('Unsupported native workflow path');
  let tree = treeId;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const entries = await repo.readTree(tree), entry = entries?.find(item => item.name === parts[i]);
    if (!entry || !sha(entry.hash) || entry.type !== (i === parts.length - 1 ? 'blob' : 'tree')) throw Error('Native workflow source missing');
    tree = entry.hash;
  }
  const blob = await repo.readBlob(tree);
  if (!blob || blob.size < 1 || blob.size > 32768) throw Error('Native workflow source limit');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length !== blob.size) throw Error('Native workflow source changed');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { path, blobId: tree, plan: format === 'actions-act' ? { format, catalog: nativeActionsCatalog } : nativeWorkflow(format, source) };
}
