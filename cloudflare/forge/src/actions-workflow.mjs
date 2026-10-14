/*!
 * yaml Copyright Eemeli Aro <eemeli@gmail.com> — ISC license, see native-workflow.mjs.
 */
// GitHub/Forgejo Actions workflows for the stock Forgejo Runner: discovery, `on:` filters and job expansion.
// The server expands each workflow into single-job payloads (one per matrix combination), the way Forgejo's
// jobparser does; the runner executes steps, `if:`, expressions inside steps, services and actions itself.
import { parseDocument, stringify } from '../../agents/node_modules/yaml/browser/index.js';
import { evaluate, interpolate, interpolateDeep, expressionText, ExpressionUnsupported } from './actions-expressions.mjs';
import { sha } from './git.mjs';

export class WorkflowRefused extends Error {}
const refuse = message => { throw new WorkflowRefused(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const workflowDirectories = ['.forgejo/workflows', '.github/workflows'];
export const workflowLimits = { files: 32, bytes: 256 * 1024, jobs: 256, matrix: 256 };
export const supportedEvents = ['push', 'pull_request', 'workflow_dispatch'];

// Every workflow file at a commit; .forgejo/workflows wins over .github/workflows as on Forgejo.
export async function discoverWorkflows(repo, commitId) {
  const commit = await repo.readCommit(commitId);
  if (!commit || !sha(commit.treeHash)) refuse('The commit is not in this repository.');
  const subtree = async (tree, path) => {
    let hash = tree;
    for (const part of path.split('/')) {
      const entries = await repo.readTree(hash), entry = entries?.find(item => item.name === part);
      if (!entry || entry.type !== 'tree') return null;
      hash = entry.hash;
    }
    return repo.readTree(hash);
  };
  for (const directory of workflowDirectories) {
    const entries = await subtree(commit.treeHash, directory);
    if (!entries) continue;
    const files = entries.filter(entry => ['blob', 'exec'].includes(entry.type) && /\.ya?ml$/.test(entry.name)).sort((a, b) => a.name < b.name ? -1 : 1);
    const result = [];
    for (const entry of files.slice(0, workflowLimits.files)) {
      const path = directory + '/' + entry.name, blob = await repo.readBlob(entry.hash);
      if (!blob || blob.size > workflowLimits.bytes) { result.push({ path, blobId: entry.hash, error: `Workflow file exceeds ${workflowLimits.bytes / 1024} KiB.` }); continue; }
      try { result.push({ path, blobId: entry.hash, source: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(await blob.arrayBuffer())) }); }
      catch { result.push({ path, blobId: entry.hash, error: 'Workflow file is not UTF-8 text.' }); }
    }
    if (files.length > workflowLimits.files) result.push({ path: directory, blobId: '', error: `Only the first ${workflowLimits.files} workflow files are read.` });
    return result;
  }
  return [];
}

export function parseWorkflow(source) {
  const document = parseDocument(source, { uniqueKeys: true, maxAliasCount: 1000, merge: true, prettyErrors: false });
  if (document.errors.length) refuse('Invalid YAML: ' + document.errors[0].message.split('\n')[0]);
  const root = document.toJS({ maxAliasCount: 1000 });
  if (!object(root)) refuse('A workflow is a YAML mapping.');
  // YAML 1.1 readers turn a bare `on` key into true; accept both spellings.
  if (root.on === undefined && Object.hasOwn(root, 'true')) { root.on = root.true; delete root.true; }
  if (root.on === undefined) refuse('The workflow has no `on:` trigger.');
  if (!object(root.jobs) || !Object.keys(root.jobs).length) refuse('The workflow has no jobs.');
  return root;
}

// `on:` as { event: config|null }.
export function workflowEvents(root) {
  const on = root.on;
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.filter(item => typeof item === 'string').map(item => [item, null]));
  if (object(on)) return Object.fromEntries(Object.entries(on).map(([event, config]) => [event, object(config) ? config : null]));
  refuse('Unsupported `on:` value.');
}

// GitHub filter patterns: *, **, ?, +, [..] and leading ! negation, evaluated in order.
function globRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') { if (pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') { out = out.slice(0, -2) + '(?:.*/)?'; i++; } } else out += '[^/]*'; }
    else if (c === '?') out += '[^/]';
    else if (c === '+') out += '+';
    else if (c === '[') { const end = pattern.indexOf(']', i); if (end < 0) refuse('Invalid filter pattern: ' + pattern); out += pattern.slice(i, end + 1); i = end; }
    else out += c.replace(/[.^$|(){}\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}
export function filterMatches(patterns, value) {
  let matched = false;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern) refuse('Filter patterns are strings.');
    if (pattern.startsWith('!')) { if (globRegex(pattern.slice(1)).test(value)) matched = false; }
    else if (globRegex(pattern).test(value)) matched = true;
  }
  return matched;
}
const list = (value, name) => {
  if (value === undefined) return undefined;
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) refuse(`\`${name}\` must be a string or a list of strings.`);
  return items;
};
const filterKeys = { push: ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore'], pull_request: ['branches', 'branches-ignore', 'paths', 'paths-ignore', 'types'], workflow_dispatch: ['inputs'] };
const prTypes = ['opened', 'synchronize', 'reopened', 'closed', 'edited', 'assigned', 'unassigned', 'labeled', 'unlabeled', 'review_requested', 'review_request_removed', 'ready_for_review', 'converted_to_draft', 'locked', 'unlocked', 'auto_merge_enabled', 'auto_merge_disabled', 'milestoned', 'demilestoned', 'enqueued', 'dequeued'];

// trigger = { event, ref, action?, baseRef?, changedFiles: string[]|null }. → { match, reason? }; WorkflowRefused for filters Golf cannot evaluate.
export function matchTrigger(root, trigger) {
  const events = workflowEvents(root);
  if (!Object.hasOwn(events, trigger.event)) return { match: false };
  const config = events[trigger.event] || {};
  const unknown = Object.keys(config).filter(key => !filterKeys[trigger.event].includes(key));
  if (unknown.length) refuse(`Unsupported ${trigger.event} filter: ${unknown.join(', ')}.`);
  for (const [a, b] of [['branches', 'branches-ignore'], ['tags', 'tags-ignore'], ['paths', 'paths-ignore']]) if (config[a] !== undefined && config[b] !== undefined) refuse(`\`${a}\` and \`${b}\` cannot both be used for ${trigger.event}.`);
  if (trigger.event === 'workflow_dispatch') return { match: true };
  if (trigger.event === 'pull_request') {
    const types = list(config.types, 'types') || ['opened', 'synchronize', 'reopened'];
    if (types.some(type => !prTypes.includes(type))) refuse('Unknown pull_request type.');
    if (!types.includes(trigger.action)) return { match: false };
    const branch = trigger.baseRef;
    if (config.branches !== undefined && !filterMatches(list(config.branches, 'branches'), branch)) return { match: false };
    if (config['branches-ignore'] !== undefined && filterMatches(list(config['branches-ignore'], 'branches-ignore'), branch)) return { match: false };
  } else {
    const isTag = trigger.ref.startsWith('refs/tags/'), name = trigger.ref.replace(/^refs\/(heads|tags)\//, '');
    const branchFilter = config.branches !== undefined || config['branches-ignore'] !== undefined, tagFilter = config.tags !== undefined || config['tags-ignore'] !== undefined;
    if (isTag) {
      // Only branch filters: tags never match. Only path filters: tags never match either (GitHub).
      if (!tagFilter && (branchFilter || config.paths !== undefined || config['paths-ignore'] !== undefined)) return { match: false };
      if (config.tags !== undefined && !filterMatches(list(config.tags, 'tags'), name)) return { match: false };
      if (config['tags-ignore'] !== undefined && filterMatches(list(config['tags-ignore'], 'tags-ignore'), name)) return { match: false };
      return { match: true };
    }
    if (!branchFilter && tagFilter) return { match: false };
    if (config.branches !== undefined && !filterMatches(list(config.branches, 'branches'), name)) return { match: false };
    if (config['branches-ignore'] !== undefined && filterMatches(list(config['branches-ignore'], 'branches-ignore'), name)) return { match: false };
  }
  // Path filters need the changed files; unknown (new branch, oversized diff) runs the workflow, as GitHub does past its file limit.
  if (trigger.changedFiles) {
    if (config.paths !== undefined && !trigger.changedFiles.some(file => filterMatches(list(config.paths, 'paths'), file))) return { match: false };
    if (config['paths-ignore'] !== undefined && trigger.changedFiles.length && trigger.changedFiles.every(file => filterMatches(list(config['paths-ignore'], 'paths-ignore'), file))) return { match: false };
  }
  return { match: true };
}

// workflow_dispatch inputs: declared, typed, with defaults. → { inputs } or WorkflowRefused.
export function dispatchInputs(root, given = {}) {
  const declared = workflowEvents(root).workflow_dispatch?.inputs || {};
  if (!object(declared)) refuse('workflow_dispatch inputs must be a mapping.');
  if (!object(given)) refuse('Inputs are a mapping.');
  const result = {};
  for (const name of Object.keys(given)) if (!Object.hasOwn(declared, name)) refuse(`Unexpected input ${name}.`);
  for (const [name, spec] of Object.entries(declared)) {
    const type = spec?.type || 'string', value = Object.hasOwn(given, name) ? given[name] : spec?.default;
    if (value === undefined || value === '') { if (spec?.required && type !== 'boolean') refuse(`Input ${name} is required.`); result[name] = type === 'boolean' ? 'false' : ''; continue; }
    const textValue = String(value);
    if (textValue.length > 1024) refuse(`Input ${name} is too long.`);
    if (type === 'boolean' && !['true', 'false'].includes(textValue)) refuse(`Input ${name} must be true or false.`);
    if (type === 'number' && !Number.isFinite(Number(textValue))) refuse(`Input ${name} must be a number.`);
    if (type === 'choice' && !(spec.options || []).map(String).includes(textValue)) refuse(`Input ${name} must be one of the listed options.`);
    if (!['string', 'boolean', 'number', 'choice', 'environment'].includes(type)) refuse(`Input type ${type} is not supported.`);
    result[name] = textValue;
  }
  return result;
}

// GitHub's matrix algorithm: cartesian product, exclude, then include (extend matching combinations or add new ones).
export function expandMatrix(matrix, context) {
  if (matrix === undefined || matrix === null) return [null];
  if (typeof matrix === 'string') {
    try { matrix = interpolate(matrix, context); } catch (error) { if (error instanceof ExpressionUnsupported) refuse('Matrix from an expression Golf cannot evaluate before the run: ' + error.message); throw error; }
  }
  if (!object(matrix)) refuse('strategy.matrix must be a mapping.');
  matrix = interpolateDeep(matrix, context);
  const include = matrix.include === undefined ? [] : matrix.include, exclude = matrix.exclude === undefined ? [] : matrix.exclude;
  if (!Array.isArray(include) || !Array.isArray(exclude) || include.some(item => !object(item)) || exclude.some(item => !object(item))) refuse('matrix include/exclude are lists of mappings.');
  const keys = Object.keys(matrix).filter(key => key !== 'include' && key !== 'exclude');
  let combos = [{}];
  for (const key of keys) {
    if (!Array.isArray(matrix[key])) refuse(`matrix.${key} must be a list.`);
    combos = combos.flatMap(combo => matrix[key].map(value => ({ ...combo, [key]: value })));
    if (combos.length > workflowLimits.matrix) refuse(`A matrix may expand to at most ${workflowLimits.matrix} jobs.`);
  }
  if (!keys.length) combos = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  combos = combos.filter(combo => !exclude.some(rule => Object.entries(rule).every(([key, value]) => same(combo[key], value) || object(value) && object(combo[key]) && Object.entries(value).every(([k, v]) => same(combo[key][k], v)))));
  const original = combos.map(combo => ({ ...combo }));
  for (const item of include) {
    let used = false;
    combos.slice(0, original.length).forEach((combo, index) => {
      // An include extends a combination when it does not overwrite any original matrix value.
      if (Object.entries(item).every(([key, value]) => !keys.includes(key) || same(original[index][key], value))) { Object.assign(combo, item); used = true; }
    });
    if (!used) combos.push({ ...item });
  }
  if (combos.length > workflowLimits.matrix) refuse(`A matrix may expand to at most ${workflowLimits.matrix} jobs.`);
  if (!combos.length) refuse('The matrix expands to no jobs.');
  return combos;
}

const jobKeyOK = key => /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key);
const reportable = value => typeof value === 'object' ? JSON.stringify(value) : String(value);
function runsOnLabels(value, context) {
  let evaluated = interpolateDeep(value, context);
  if (typeof evaluated === 'string') evaluated = [evaluated];
  if (object(evaluated)) {
    if (evaluated.group !== undefined) refuse('Runner groups (`runs-on: group:`) are not available; use labels.');
    evaluated = typeof evaluated.labels === 'string' ? [evaluated.labels] : evaluated.labels;
  }
  if (!Array.isArray(evaluated) || !evaluated.length || evaluated.some(label => typeof label !== 'string' || !label || label.length > 128)) refuse('`runs-on` must name one or more labels.');
  return evaluated;
}
function timeoutSeconds(value, context) {
  if (value === undefined) return 21600;
  const minutes = Number(interpolate(value, context));
  if (!Number.isFinite(minutes) || minutes <= 0) refuse('`timeout-minutes` must be a positive number.');
  return Math.max(60, Math.min(21600, Math.round(minutes * 60)));
}

// → { jobs: createPipelineRun jobs, notes: string[], concurrency, runName }
export function expandWorkflow(root, path, { github, inputs = {}, vars = {} }) {
  const notes = [], base = { github, inputs, vars }, jobs = [], names = new Set();
  const keys = Object.keys(root.jobs);
  if (keys.length > workflowLimits.jobs) refuse(`A workflow may have at most ${workflowLimits.jobs} jobs.`);
  for (const key of keys) {
    const job = root.jobs[key];
    if (!jobKeyOK(key)) refuse(`Job id ${key} is not a valid identifier.`);
    if (!object(job)) refuse(`Job ${key} must be a mapping.`);
    if (job.uses !== undefined) refuse(`Job ${key} calls a reusable workflow; reusable workflows are not available on Golf yet.`);
    if (job['runs-on'] === undefined) refuse(`Job ${key} has no runs-on.`);
    if (!Array.isArray(job.steps) || !job.steps.length) refuse(`Job ${key} has no steps.`);
    if (job.concurrency !== undefined) notes.push(`Job-level concurrency of ${key} is not applied.`);
    const needs = job.needs === undefined ? [] : typeof job.needs === 'string' ? [job.needs] : job.needs;
    if (!Array.isArray(needs) || needs.some(need => typeof need !== 'string' || !Object.hasOwn(root.jobs, need) || need === key)) refuse(`Job ${key} needs an unknown job.`);
    let combos;
    try { combos = expandMatrix(job.strategy?.matrix, base); }
    catch (error) { if (error instanceof ExpressionUnsupported) refuse(`Job ${key}: ${error.message}`); throw error; }
    for (const combo of combos) {
      const context = { ...base, matrix: combo || {} };
      let labels, name;
      try {
        labels = runsOnLabels(job['runs-on'], context);
        name = job.name === undefined ? key : expressionText(interpolate(String(job.name), context));
      } catch (error) { if (error instanceof ExpressionUnsupported) refuse(`Job ${key}: ${error.message}`); throw error; }
      if (combo && (job.name === undefined || !String(job.name).includes('${{'))) name += ' (' + Object.values(combo).map(reportable).join(', ') + ')';
      name = name.slice(0, 200) || key;
      for (let suffix = 2; names.has(name); suffix++) name = name.replace(/ #\d+$/, '') + ' #' + suffix;
      names.add(name);
      const single = { ...job, name, 'runs-on': labels.length === 1 ? labels[0] : labels };
      if (combo) single.strategy = { ...job.strategy, matrix: Object.fromEntries(Object.entries(combo).map(([k, v]) => [k, [v]])) };
      if (needs.length) single.needs = needs; else delete single.needs;
      const workflow = { ...(root.name !== undefined ? { name: root.name } : {}), on: root.on, ...(root.env !== undefined ? { env: root.env } : {}), ...(root.defaults !== undefined ? { defaults: root.defaults } : {}),
        ...(root.permissions !== undefined ? { permissions: root.permissions } : {}), jobs: { [key]: single } };
      const payload = stringify(workflow, { aliasDuplicateObjects: false, lineWidth: 0 });
      let environment;
      if (job.environment !== undefined) {
        try {
          const value = object(job.environment) ? job.environment : { name: job.environment };
          const name = expressionText(interpolate(String(value.name ?? ''), context)).trim();
          if (!/^[A-Za-z0-9 _./-]{1,255}$/.test(name)) refuse(`Job ${key}: environment names use letters, digits, space, _ . / - (at most 255).`);
          // The url may use step outputs, which only the runner knows; such a url is recorded empty.
          let url = '';
          try { url = value.url === undefined ? '' : expressionText(interpolate(String(value.url), context)); } catch (error) { if (!(error instanceof ExpressionUnsupported)) throw error; }
          environment = { name, url: /^https?:\/\//.test(url) ? url.slice(0, 2048) : '', action: 'start' };
        } catch (error) { if (error instanceof ExpressionUnsupported) refuse(`Job ${key}: ${error.message}`); throw error; }
      }
      const continueOnError = job['continue-on-error'] === true;
      jobs.push({ key, name, needs, runsOn: labels, payload, when: job.if !== undefined ? 'conditional' : 'on_success', allowFailure: continueOnError, timeoutSeconds: timeoutSeconds(job['timeout-minutes'], context), ...(environment ? { environment } : {}) });
    }
  }
  if (jobs.length > workflowLimits.jobs) refuse(`A workflow may expand to at most ${workflowLimits.jobs} jobs.`);
  let concurrency = null;
  if (root.concurrency !== undefined) {
    try {
      const value = object(root.concurrency) ? root.concurrency : { group: root.concurrency };
      const group = expressionText(interpolate(String(value.group ?? ''), base));
      const cancel = value['cancel-in-progress'] === undefined ? false : interpolate(value['cancel-in-progress'], base);
      if (group) concurrency = { group, cancelInProgress: cancel === true || cancel === 'true' };
    } catch (error) { if (!(error instanceof ExpressionUnsupported)) throw error; notes.push('The workflow concurrency group uses an expression Golf cannot evaluate; concurrency is not applied.'); }
  }
  let runName = '';
  if (typeof root['run-name'] === 'string') { try { runName = expressionText(interpolate(root['run-name'], base)).slice(0, 200); } catch (error) { if (!(error instanceof ExpressionUnsupported)) throw error; } }
  return { jobs, notes, concurrency, runName, workflowName: typeof root.name === 'string' && root.name ? root.name : path };
}
