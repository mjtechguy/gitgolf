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
// GitLab CI (`.gitlab-ci.yml`) → Golf pipeline jobs, and the stock GitLab Runner job payload
// (docs/NATIVE_ACTIONS_PIPELINES.md, "GitLab CI pipelines (RUN-C)"). The documented subset is executed exactly;
// anything else refuses pipeline creation with a visible reason. Nothing here touches D1 or R2.
import { parseDocument, YAMLSeq } from '../../agents/node_modules/yaml/browser/index.js';
import { Fault } from './common.mjs';
import { registerPipelinePlanner } from './actions-intake.mjs';

export const gitLabPipelinePath = '.gitlab-ci.yml';
export const gitLabSpecVersion = 1;
const limits = { file: 256 * 1024, total: 1024 * 1024, includes: 32, depth: 8, jobs: 256, needs: 50, variables: 200, value: 10 * 1024, script: 64 * 1024, payload: 128 * 1024, extends: 11, references: 10, parallel: 200 };
const refuse = message => { throw new Fault('invalid_argument', 400, String(message).slice(0, 1800)); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !(REF in value);
const REF = Symbol('gitlab-reference');
class Reference extends YAMLSeq { static tag = '!reference'; toJSON(key, ctx) { return { [REF]: super.toJSON(key, ctx) }; } }
const encoder = new TextEncoder();
const size = value => encoder.encode(value).length;
const quote = value => JSON.stringify(String(value)).slice(0, 200);
const variableName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// ---------- YAML ----------
function load(source, path) {
  if (typeof source !== 'string') refuse(`${path}: unreadable file.`);
  if (size(source) > limits.file) refuse(`${path}: larger than ${limits.file / 1024} KiB.`);
  const document = parseDocument(source, { merge: true, uniqueKeys: true, maxAliasCount: 200, prettyErrors: false,
    customTags: [{ tag: '!reference', collection: 'seq', nodeClass: Reference, default: false }] });
  const problem = document.errors[0] || document.warnings[0];
  if (problem) refuse(`${path}: YAML ${problem.message.split('\n')[0]}`);
  let root;
  try { root = document.toJS({ maxAliasCount: 200 }); } catch (error) { refuse(`${path}: YAML ${error.message}`); }
  if (root === null || root === undefined) return {};
  if (!object(root)) refuse(`${path}: the top level must be a mapping of keywords and jobs.`);
  return root;
}

const merge = (base, over) => {
  if (!object(base) || !object(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = key in base ? merge(base[key], value) : value;
  return out;
};

// ---------- globs ----------
export function globPattern(glob) {
  const body = value => {
    let out = '';
    for (let i = 0; i < value.length;) {
      const c = value[i];
      if (c === '*') {
        if (value[i + 1] === '*') { if (value[i + 2] === '/') { out += '(?:.*/)?'; i += 3; } else { out += '.*'; i += 2; } }
        else { out += '[^/]*'; i++; }
      } else if (c === '?') { out += '[^/]'; i++; }
      else if (c === '{') {
        let depth = 0, j = i;
        for (; j < value.length; j++) { if (value[j] === '{') depth++; else if (value[j] === '}' && --depth === 0) break; }
        if (j >= value.length) { out += '\\{'; i++; continue; }
        const parts = [], inner = value.slice(i + 1, j);
        let start = 0; depth = 0;
        for (let k = 0; k < inner.length; k++) { if (inner[k] === '{') depth++; else if (inner[k] === '}') depth--; else if (inner[k] === ',' && !depth) { parts.push(inner.slice(start, k)); start = k + 1; } }
        parts.push(inner.slice(start));
        out += '(?:' + parts.map(body).join('|') + ')'; i = j + 1;
      } else if (c === '[') {
        const j = value.indexOf(']', i + 2);
        if (j < 0) { out += '\\['; i++; continue; }
        const set = value.slice(i + 1, j).replace(/\\/g, '\\\\');
        out += '[' + (set[0] === '!' ? '^' + set.slice(1) : set) + ']'; i = j + 1;
      } else { out += c.replace(/[.+^$()|\\\]]/g, '\\$&'); i++; }
    }
    return out;
  };
  if (typeof glob !== 'string' || !glob || glob.length > 512) refuse(`Invalid path pattern ${quote(glob)}.`);
  return new RegExp('^' + body(glob.replace(/^\.?\//, '')) + '$');
}
const globbed = value => /[*?[{]/.test(value);

// ---------- expressions (rules:if, only/except:variables) ----------
function tokens(source) {
  const out = [];
  for (let i = 0; i < source.length;) {
    const rest = source.slice(i);
    let m;
    if (/^\s/.test(rest)) { i++; continue; }
    if ((m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(rest))) { out.push({ t: 'var', v: m[1] }); i += m[0].length; continue; }
    if ((m = /^(==|!=|=~|!~|&&|\|\||\(|\))/.exec(rest))) { out.push({ t: m[1] }); i += m[0].length; continue; }
    if ((m = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/.exec(rest))) { out.push({ t: 'str', v: (m[1] ?? m[2]).replace(/\\(.)/g, '$1') }); i += m[0].length; continue; }
    if ((m = /^null\b/.exec(rest))) { out.push({ t: 'null' }); i += 4; continue; }
    if ((m = /^\/((?:[^/\\]|\\.)*)\/([imsx]*)/.exec(rest))) { out.push({ t: 're', v: m[1], f: m[2] }); i += m[0].length; continue; }
    refuse(`Unsupported expression ${quote(source)} near ${quote(rest.slice(0, 20))}.`);
  }
  return out;
}
const regex = (pattern, flags = '') => {
  if (pattern.length > 512) refuse('A rules regular expression is longer than 512 characters.');
  let source = pattern, extra = '';
  const inline = /^\(\?([ims]+)\)/.exec(source);
  if (inline) { extra = inline[1]; source = source.slice(inline[0].length); }
  try { return new RegExp(source, [...new Set((flags + extra).replace('x', ''))].join('')); } catch { refuse(`Invalid regular expression /${pattern}/.`); }
};
export function evaluate(expression, lookup) {
  if (typeof expression !== 'string' || expression.length > 4096) refuse('A rules:if expression must be a string of at most 4096 characters.');
  const list = tokens(expression);
  let at = 0;
  const peek = () => list[at], take = type => { if (list[at]?.t !== type) refuse(`Unsupported expression ${quote(expression)}.`); return list[at++]; };
  const operand = () => {
    const token = list[at++];
    if (!token) refuse(`Incomplete expression ${quote(expression)}.`);
    if (token.t === 'var') { const value = lookup(token.v); return { kind: 'value', value: value === undefined ? null : value }; }
    if (token.t === 'str') return { kind: 'value', value: token.v };
    if (token.t === 'null') return { kind: 'value', value: null };
    if (token.t === 're') return { kind: 're', value: regex(token.v, token.f) };
    refuse(`Unsupported expression ${quote(expression)}.`);
  };
  const truthy = item => item.kind === 'value' ? item.value !== null && item.value !== '' : true;
  const comparison = () => {
    if (peek()?.t === '(') { at++; const value = or(); take(')'); return value; }
    const left = operand(), op = peek()?.t;
    if (!['==', '!=', '=~', '!~'].includes(op)) return truthy(left);
    at++;
    const right = operand();
    if (op === '==' || op === '!=') {
      if (left.kind !== 'value' || right.kind !== 'value') refuse(`Compare values, not patterns, in ${quote(expression)}.`);
      return (left.value === right.value) === (op === '==');
    }
    let pattern = right.kind === 're' ? right.value : null;
    if (!pattern && typeof right.value === 'string') {
      const m = /^\/(.*)\/([imsx]*)$/s.exec(right.value);
      if (!m) refuse(`The variable on the right of ${op} in ${quote(expression)} does not hold a /pattern/.`);
      pattern = regex(m[1], m[2]);
    }
    if (!pattern) return op === '!~';
    const subject = left.kind === 'value' && left.value !== null ? String(left.value).slice(0, 10000) : null;
    const matched = subject !== null && pattern.test(subject);
    return op === '=~' ? matched : !matched;
  };
  const and = () => { let value = comparison(); while (peek()?.t === '&&') { at++; const right = comparison(); value = value && right; } return value; };
  const or = () => { let value = and(); while (peek()?.t === '||') { at++; const right = and(); value = value || right; } return value; };
  const result = or();
  if (at !== list.length) refuse(`Unsupported expression ${quote(expression)}.`);
  return result;
}

// ---------- values ----------
const scalar = (value, where) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return String(value);
  refuse(`${where} must be a string, number or boolean.`);
};
function variables(value, where, top = false) {
  if (value === undefined || value === null) return {};
  if (!object(value)) refuse(`${where}: variables must be a mapping.`);
  const out = {};
  const entries = Object.entries(value);
  if (entries.length > limits.variables) refuse(`${where}: more than ${limits.variables} variables.`);
  for (const [name, raw] of entries) {
    if (!variableName.test(name)) refuse(`${where}: invalid variable name ${quote(name)}.`);
    let entry = { value: '', raw: false };
    if (object(raw)) {
      const unknown = Object.keys(raw).filter(key => !['value', 'description', 'expand', 'options'].includes(key));
      if (unknown.length) refuse(`${where}: variable ${name} uses unsupported keys ${unknown.join(', ')}.`);
      if (!top && (raw.description !== undefined || raw.options !== undefined)) refuse(`${where}: variable descriptions and options are only valid at the top level.`);
      if (raw.expand !== undefined && typeof raw.expand !== 'boolean') refuse(`${where}: variables:${name}:expand must be a boolean.`);
      entry = { value: raw.value === undefined ? '' : scalar(raw.value, `${where}: variables:${name}:value`), raw: raw.expand === false };
    } else entry = { value: scalar(raw, `${where}: variables:${name}`), raw: false };
    if (size(entry.value) > limits.value) refuse(`${where}: variable ${name} exceeds ${limits.value / 1024} KiB.`);
    out[name] = entry;
  }
  return out;
}
// One expansion pass with nested references, like the runner's $VAR / ${VAR} expansion.
export function expand(text, lookup, depth = 0) {
  if (typeof text !== 'string' || depth > 5) return text;
  return text.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, braced, bare) => {
    if (all === '$$') return '$';
    const value = lookup(braced || bare);
    return value === undefined || value === null ? '' : expand(String(value), lookup, depth + 1);
  });
}

const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 63).replace(/^-+|-+$/g, '');

// Pipeline-level predefined variables known before the run exists (rules and workflow:rules see these).
export function pipelineVariables(context) {
  const c = context || {}, ref = String(c.ref || '');
  const tag = ref.startsWith('refs/tags/') ? ref.slice(10) : '';
  const mergeRequest = c.event === 'merge_request_event';
  const branch = ref.startsWith('refs/heads/') ? ref.slice(11) : mergeRequest ? String(c.headRef || '') : '';
  const name = tag || branch || ref;
  const origin = String(c.origin || '');
  const url = origin ? new URL(origin) : null;
  const vars = {
    CI: 'true', GITLAB_CI: 'true', CI_SERVER: 'yes', CI_SERVER_NAME: 'Golf',
    CI_PIPELINE_SOURCE: c.event === 'merge_request_event' ? 'merge_request_event' : c.event || 'push',
    CI_COMMIT_SHA: c.commitId || '', CI_COMMIT_SHORT_SHA: String(c.commitId || '').slice(0, 8), CI_COMMIT_BEFORE_SHA: c.beforeSha || '0'.repeat(40),
    CI_COMMIT_REF_NAME: name, CI_COMMIT_REF_SLUG: slug(name), CI_COMMIT_REF_PROTECTED: 'false',
    CI_DEFAULT_BRANCH: c.defaultBranch || 'main',
    CI_PROJECT_PATH: c.projectPath || '', CI_PROJECT_PATH_SLUG: slug(c.projectPath || ''),
    CI_PROJECT_NAME: String(c.projectPath || '').split('/').pop(), CI_PROJECT_NAMESPACE: String(c.projectPath || '').split('/').slice(0, -1).join('/'),
    CI_PROJECT_ROOT_NAMESPACE: String(c.projectPath || '').split('/')[0],
  };
  if (url) Object.assign(vars, { CI_SERVER_URL: origin, CI_SERVER_HOST: url.hostname, CI_SERVER_PROTOCOL: url.protocol.slice(0, -1),
    CI_SERVER_PORT: url.port || (url.protocol === 'https:' ? '443' : '80'), CI_API_V4_URL: origin + '/api/v4', CI_PROJECT_URL: origin + '/' + (c.projectPath || '') });
  if (c.projectPath) vars.CI_PROJECT_TITLE = vars.CI_PROJECT_NAME;
  if (tag) vars.CI_COMMIT_TAG = tag;
  if (branch && !mergeRequest) vars.CI_COMMIT_BRANCH = branch;
  if (mergeRequest) Object.assign(vars, { CI_MERGE_REQUEST_IID: String(c.pullNumber ?? ''), CI_MERGE_REQUEST_ID: String(c.pullNumber ?? ''), CI_MERGE_REQUEST_EVENT_TYPE: 'detached',
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: String(c.headRef || ''), CI_MERGE_REQUEST_TARGET_BRANCH_NAME: String(c.baseRef || ''),
    CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: c.commitId || '', CI_MERGE_REQUEST_PROJECT_PATH: c.projectPath || '', CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: c.projectPath || '' });
  if (typeof c.commitMessage === 'string' && c.commitMessage) {
    const message = c.commitMessage.slice(0, 20000), title = message.split('\n')[0];
    Object.assign(vars, { CI_COMMIT_MESSAGE: message, CI_COMMIT_TITLE: title, CI_COMMIT_DESCRIPTION: message.slice(title.length).replace(/^\n+/, '') });
  }
  return vars;
}

// ---------- durations ----------
const units = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400, w: 604800, wk: 604800, week: 604800, weeks: 604800, mo: 2592000, month: 2592000, months: 2592000, y: 31536000, yr: 31536000, year: 31536000, years: 31536000 };
export function duration(value, where) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || value.length > 64) refuse(`${where}: invalid duration.`);
  const text = value.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0, matched = '';
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)\s*(?:and\s*)?,?\s*/g)) {
    if (!(m[2] in units)) refuse(`${where}: unknown duration unit ${quote(m[2])}.`);
    total += Number(m[1]) * units[m[2]]; matched += m[0];
  }
  if (!matched || matched.length !== text.length) refuse(`${where}: invalid duration ${quote(value)}.`);
  return Math.round(total);
}

// ---------- includes and references ----------
const includeKeys = ['local', 'rules', 'inputs', 'remote', 'project', 'file', 'ref', 'template', 'component', 'integrity', 'cache'];
async function includes(root, path, input, state, depth) {
  if (!('include' in root)) return root;
  if (depth >= limits.depth) refuse(`${path}: includes nest deeper than ${limits.depth} levels.`);
  const { include, ...rest } = root;
  let merged = {};
  for (const entry of [include].flat()) {
    let spec = typeof entry === 'string' ? (/^https?:\/\//i.test(entry) ? { remote: entry } : { local: entry }) : entry;
    if (!object(spec)) refuse(`${path}: include entries are paths or mappings.`);
    const unknown = Object.keys(spec).filter(key => !includeKeys.includes(key));
    if (unknown.length) refuse(`${path}: include uses unknown keys ${unknown.join(', ')}.`);
    if (spec.remote !== undefined) refuse(`${path}: include:remote (${quote(spec.remote)}) is not supported; Golf includes only files of the same repository and commit (include:local).`);
    if (spec.project !== undefined || spec.file !== undefined) refuse(`${path}: include:project is not supported; Golf includes only files of the same repository and commit (include:local).`);
    if (spec.template !== undefined) refuse(`${path}: include:template (${quote(spec.template)}) is not supported; GitLab's template library is not available on Golf.`);
    if (spec.component !== undefined) refuse(`${path}: include:component (CI/CD components) is not supported.`);
    if (spec.inputs !== undefined) refuse(`${path}: include:inputs (spec:inputs) is not supported.`);
    if (spec.integrity !== undefined || spec.cache !== undefined) refuse(`${path}: include:integrity and include:cache apply only to remote includes, which Golf does not support.`);
    if (typeof spec.local !== 'string' || !spec.local.trim()) refuse(`${path}: include needs a local path.`);
    if (spec.rules !== undefined) {
      const decision = await rulesDecision(spec.rules, `${path}: include ${quote(spec.local)}`, input.lookup, input, ['if', 'exists', 'changes', 'when']);
      if (!decision || decision.when === 'never') continue;
    }
    const local = spec.local.trim().replace(/^\/+/, '');
    if (!/\.ya?ml$/.test(local)) refuse(`${path}: included file ${quote(local)} must end in .yml or .yaml.`);
    let paths = [local];
    if (globbed(local)) {
      if (!Array.isArray(input.files)) refuse(`${path}: include:local wildcard ${quote(local)} needs the repository file list, which was unavailable for this commit.`);
      const pattern = globPattern(local);
      paths = input.files.filter(file => pattern.test(file)).sort();
    }
    for (const file of paths) {
      if (state.seen.has(file)) continue;
      state.seen.add(file);
      if (state.seen.size > limits.includes) refuse(`More than ${limits.includes} included files.`);
      const source = await input.readFile(file);
      if (source === null || source === undefined) refuse(`${path}: included file ${quote(file)} does not exist in this commit.`);
      state.total += size(source);
      if (state.total > limits.total) refuse(`Included configuration exceeds ${limits.total / 1024} KiB.`);
      merged = merge(merged, await includes(load(source, file), file, input, state, depth + 1));
    }
  }
  return merge(merged, rest);
}
function references(config) {
  const resolve = (value, depth) => {
    if (Array.isArray(value)) return value.map(item => resolve(item, depth));
    if (value && typeof value === 'object' && REF in value) {
      if (depth >= limits.references) refuse(`!reference tags nest deeper than ${limits.references} levels.`);
      const route = value[REF];
      if (!Array.isArray(route) || !route.length || route.some(part => typeof part !== 'string')) refuse('!reference needs a list of keys.');
      let target = config;
      for (const part of route) { if (!object(target) || !(part in target)) refuse(`!reference [${route.join(', ')}] does not exist.`); target = target[part]; }
      return resolve(target, depth + 1);
    }
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, depth)]));
    return value;
  };
  return resolve(config, 0);
}
function extendsJob(config, name, stack = []) {
  const job = config[name];
  if (!object(job)) refuse(`extends: ${quote(name)} is not a job or hidden template.`);
  if (job.extends === undefined) return job;
  if (stack.includes(name)) refuse(`extends loop through ${quote(name)}.`);
  if (stack.length >= limits.extends) refuse(`extends nests deeper than ${limits.extends} levels at ${quote(name)}.`);
  const parents = [job.extends].flat();
  if (parents.some(parent => typeof parent !== 'string') || parents.length > 20) refuse(`${quote(name)}: extends must name templates.`);
  let out = {};
  for (const parent of parents) {
    if (!(parent in config)) refuse(`${quote(name)}: extends ${quote(parent)}, which is not defined.`);
    out = merge(out, extendsJob(config, parent, [...stack, name]));
  }
  const { extends: _, ...own } = job;
  return merge(out, own);
}

// ---------- rules, only/except ----------
const ruleKeys = ['if', 'changes', 'exists', 'when', 'allow_failure', 'variables', 'needs', 'interruptible', 'start_in'];
async function matchFiles(spec, where, kind, input) {
  let paths = spec;
  if (object(spec)) {
    const extra = Object.keys(spec).filter(key => key !== 'paths');
    if (extra.length) refuse(`${where}: ${kind}:${extra[0]} is not supported (only ${kind}:paths).`);
    paths = spec.paths;
  }
  if (!Array.isArray(paths) || !paths.length || paths.length > 50 || paths.some(path => typeof path !== 'string')) refuse(`${where}: ${kind} needs 1 to 50 path patterns.`);
  const patterns = paths.map(path => expand(path, input.lookup));
  if (kind === 'changes') {
    if (!Array.isArray(input.changedFiles)) { input.notes.add('rules:changes and only/except:changes evaluate as true when Golf has no before-sha diff (new branch, tag, web or schedule pipelines), as GitLab does.'); return true; }
    return patterns.some(pattern => { const re = globPattern(pattern); return input.changedFiles.some(file => re.test(file)); });
  }
  if (Array.isArray(input.files)) return patterns.some(pattern => { const re = globPattern(pattern); return input.files.some(file => re.test(file)); });
  for (const pattern of patterns) {
    if (globbed(pattern)) refuse(`${where}: exists pattern ${quote(pattern)} needs the repository file list, which was unavailable for this commit.`);
    const content = await input.readFile(pattern.replace(/^\.?\//, ''));
    if (content !== null && content !== undefined) return true;
  }
  return false;
}
async function rulesDecision(rules, where, lookup, input, allowed = ruleKeys) {
  if (!Array.isArray(rules) || rules.length > 50) refuse(`${where}: rules must be a list of at most 50 rules.`);
  for (const [index, rule] of rules.entries()) {
    if (!object(rule)) refuse(`${where}: rules[${index}] must be a mapping.`);
    const unknown = Object.keys(rule).filter(key => !allowed.includes(key));
    if (unknown.length) refuse(`${where}: rules[${index}] uses ${unknown.map(key => 'rules:' + key).join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not supported here.`);
    if (rule.start_in !== undefined) refuse(`${where}: rules:start_in (delayed jobs) is not supported.`);
    if (rule.if !== undefined && !evaluate(rule.if, lookup)) continue;
    if (rule.changes !== undefined && !await matchFiles(rule.changes, where, 'changes', input)) continue;
    if (rule.exists !== undefined && !await matchFiles(rule.exists, where, 'exists', input)) continue;
    return rule;
  }
  return null;
}
const refKeywords = ['branches', 'tags', 'merge_requests', 'pushes', 'web', 'schedules', 'api', 'triggers', 'pipelines', 'external', 'external_pull_requests', 'chats'];
async function onlyExcept(spec, where, kind, ctx, input) {
  const normal = Array.isArray(spec) || typeof spec === 'string' ? { refs: [spec].flat() } : spec;
  if (!object(normal)) refuse(`${where}: ${kind} must be a list of refs or a mapping.`);
  const extra = Object.keys(normal).filter(key => !['refs', 'variables', 'changes'].includes(key));
  if (extra.length) refuse(`${where}: ${kind}:${extra[0]} is not supported.`);
  const checks = [];
  if (normal.refs !== undefined) {
    const refs = [normal.refs].flat();
    if (refs.some(ref => typeof ref !== 'string')) refuse(`${where}: ${kind}:refs must be strings.`);
    checks.push(refs.some(ref => {
      let name = ref;
      const at = ref.lastIndexOf('@');
      if (at > 0 && !ref.startsWith('/')) { if (ref.slice(at + 1) !== ctx.vars.CI_PROJECT_PATH) return false; name = ref.slice(0, at); }
      if (refKeywords.includes(name)) return name === 'branches' ? Boolean(ctx.vars.CI_COMMIT_BRANCH) : name === 'tags' ? Boolean(ctx.vars.CI_COMMIT_TAG)
        : name === 'merge_requests' ? ctx.event === 'merge_request_event' : name === 'pushes' ? ctx.event === 'push'
        : name === 'web' ? ctx.event === 'web' : name === 'schedules' ? ctx.event === 'schedule' : false;
      if (ctx.event === 'merge_request_event') return false;
      const m = /^\/(.*)\/([a-z]*)$/s.exec(name);
      return m ? regex(m[1], m[2]).test(ctx.vars.CI_COMMIT_REF_NAME) : name === ctx.vars.CI_COMMIT_REF_NAME;
    }));
  }
  if (normal.variables !== undefined) {
    const list = [normal.variables].flat();
    if (list.some(item => typeof item !== 'string')) refuse(`${where}: ${kind}:variables must be expressions.`);
    checks.push(list.some(item => evaluate(item, input.lookup)));
  }
  if (normal.changes !== undefined) checks.push(await matchFiles(normal.changes, where, 'changes', input));
  return kind === 'only' ? checks.every(Boolean) : checks.some(Boolean);
}

// ---------- job keywords ----------
const jobKeys = ['stage', 'script', 'before_script', 'after_script', 'image', 'services', 'variables', 'needs', 'dependencies', 'rules', 'only', 'except', 'when', 'allow_failure',
  'artifacts', 'cache', 'retry', 'timeout', 'parallel', 'tags', 'interruptible', 'coverage', 'inherit', 'extends', 'environment'];
const refusedJobKeys = {
  trigger: 'trigger (child and multi-project pipelines) is not supported', release: 'release is not supported',
  secrets: 'external secret providers (secrets:) are not supported; use repository secrets', id_tokens: 'id_tokens (OIDC) are not supported', resource_group: 'resource_group is not supported',
  pages: 'GitLab Pages deployment is not supported on Golf', publish: 'GitLab Pages deployment is not supported on Golf', hooks: 'hooks are not supported', identity: 'identity is not supported',
  run: 'run (CI/CD steps) is not supported', manual_confirmation: 'manual_confirmation is not supported', start_in: 'delayed jobs (start_in) are not supported',
  dast_configuration: 'dast_configuration is not supported', type: 'the deprecated type keyword is not supported; use stage',
};
const defaultKeys = ['image', 'services', 'before_script', 'after_script', 'cache', 'artifacts', 'retry', 'timeout', 'interruptible', 'tags'];
const topKeys = ['stages', 'types', 'variables', 'default', 'workflow', 'include', 'image', 'services', 'before_script', 'after_script', 'cache'];
const reportFormats = { junit: 'gzip', dotenv: 'gzip', coverage_report: 'gzip', cobertura: 'gzip', metrics: 'gzip', cyclonedx: 'gzip', annotations: 'gzip', codequality: 'raw', sast: 'raw',
  dependency_scanning: 'raw', container_scanning: 'raw', dast: 'raw', license_scanning: 'raw', secret_detection: 'raw', terraform: 'raw', requirements: 'raw', performance: 'raw',
  browser_performance: 'raw', load_performance: 'raw', accessibility: 'raw', api_fuzzing: 'raw', coverage_fuzzing: 'raw', cluster_image_scanning: 'raw' };

function scriptList(value, where) {
  if (value === undefined || value === null) return undefined;
  const out = [];
  const walk = (item, depth) => {
    if (Array.isArray(item)) { if (depth > 10) refuse(`${where} nests deeper than 10 levels.`); for (const inner of item) walk(inner, depth + 1); }
    else out.push(scalar(item, where));
  };
  walk(value, 0);
  if (size(out.join('\n')) > limits.script) refuse(`${where} exceeds ${limits.script / 1024} KiB.`);
  return out;
}
function imageSpec(value, where) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { name: value };
  if (!object(value)) refuse(`${where}: image must be a name or a mapping.`);
  const extra = Object.keys(value).filter(key => !['name', 'entrypoint', 'pull_policy', 'docker'].includes(key));
  if (extra.length) refuse(`${where}: image:${extra[0]} is not supported.`);
  if (typeof value.name !== 'string' || !value.name) refuse(`${where}: image:name is required.`);
  const out = { name: value.name };
  if (value.entrypoint !== undefined) out.entrypoint = scriptList(value.entrypoint, `${where}: image:entrypoint`);
  if (value.pull_policy !== undefined) out.pull_policy = pullPolicy(value.pull_policy, where);
  if (value.docker !== undefined) out.executor_opts = { docker: dockerOptions(value.docker, where) };
  return out;
}
const pullPolicy = (value, where) => {
  const list = [value].flat();
  if (list.some(item => !['always', 'if-not-present', 'never'].includes(item))) refuse(`${where}: pull_policy must be always, if-not-present or never.`);
  return list;
};
const dockerOptions = (value, where) => {
  if (!object(value) || Object.keys(value).some(key => !['platform', 'user'].includes(key)) || Object.values(value).some(item => typeof item !== 'string')) refuse(`${where}: docker options support platform and user strings.`);
  return value;
};
function servicesSpec(value, where) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 20) refuse(`${where}: services must be a list of at most 20 images.`);
  return value.map(item => {
    if (typeof item === 'string') return { name: item };
    if (!object(item)) refuse(`${where}: each service is a name or a mapping.`);
    const extra = Object.keys(item).filter(key => !['name', 'alias', 'command', 'entrypoint', 'variables', 'pull_policy', 'docker'].includes(key));
    if (extra.length) refuse(`${where}: services:${extra[0]} is not supported.`);
    if (typeof item.name !== 'string' || !item.name) refuse(`${where}: services:name is required.`);
    const out = { name: item.name };
    if (item.alias !== undefined) { if (typeof item.alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._,-]{0,253}$/.test(item.alias)) refuse(`${where}: invalid service alias ${quote(item.alias)}.`); out.alias = item.alias; }
    if (item.command !== undefined) out.command = scriptList(item.command, `${where}: services:command`);
    if (item.entrypoint !== undefined) out.entrypoint = scriptList(item.entrypoint, `${where}: services:entrypoint`);
    if (item.variables !== undefined) out.variables = Object.entries(variables(item.variables, `${where}: services`)).map(([key, entry]) => ({ key, value: entry.value }));
    if (item.pull_policy !== undefined) out.pull_policy = pullPolicy(item.pull_policy, where);
    if (item.docker !== undefined) out.executor_opts = { docker: dockerOptions(item.docker, where) };
    return out;
  });
}
const whenValues = ['on_success', 'on_failure', 'always'];
function artifactsSpec(value, where, notes) {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) refuse(`${where}: artifacts must be a mapping.`);
  const extra = Object.keys(value).filter(key => !['paths', 'exclude', 'expire_in', 'when', 'name', 'untracked', 'reports'].includes(key));
  if (extra.length) refuse(`${where}: artifacts:${extra[0]} is not supported.`);
  const list = (item, key) => { if (item === undefined) return []; if (!Array.isArray(item) || item.length > 100 || item.some(path => typeof path !== 'string')) refuse(`${where}: artifacts:${key} must be a list of paths.`); return item; };
  if (value.when !== undefined && !whenValues.includes(value.when)) refuse(`${where}: artifacts:when must be on_success, on_failure or always.`);
  if (value.untracked !== undefined && typeof value.untracked !== 'boolean') refuse(`${where}: artifacts:untracked must be a boolean.`);
  if (value.name !== undefined && typeof value.name !== 'string') refuse(`${where}: artifacts:name must be a string.`);
  const expireIn = value.expire_in === undefined ? '' : String(value.expire_in);
  if (expireIn && expireIn !== 'never') duration(expireIn, `${where}: artifacts:expire_in`);
  const out = [];
  const paths = list(value.paths, 'paths'), exclude = list(value.exclude, 'exclude');
  if (paths.length || value.untracked) out.push({ name: value.name || 'artifacts', untracked: Boolean(value.untracked), paths, exclude, when: value.when || 'on_success', artifact_type: 'archive', artifact_format: 'zip', expire_in: expireIn });
  if (value.reports !== undefined) {
    if (!object(value.reports)) refuse(`${where}: artifacts:reports must be a mapping.`);
    for (const [type, spec] of Object.entries(value.reports)) {
      if (!(type in reportFormats)) refuse(`${where}: artifacts:reports:${type} is not supported.`);
      let reportPaths = spec;
      if (type === 'coverage_report') {
        if (!object(spec) || typeof spec.path !== 'string') refuse(`${where}: artifacts:reports:coverage_report needs coverage_format and path.`);
        reportPaths = [spec.path];
      }
      reportPaths = [reportPaths].flat();
      if (reportPaths.some(path => typeof path !== 'string') || reportPaths.length > 50) refuse(`${where}: artifacts:reports:${type} must name paths.`);
      out.push({ name: type, untracked: false, paths: reportPaths, exclude: [], when: 'always', artifact_type: type === 'coverage_report' ? 'cobertura' : type, artifact_format: reportFormats[type], expire_in: expireIn });
    }
    if (Object.keys(value.reports).some(type => type !== 'dotenv')) notes.add('artifacts:reports are stored as downloadable report artifacts; Golf does not render test, coverage or security report widgets.');
  }
  return out;
}
async function cacheSpec(value, where, input) {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 4) refuse(`${where}: at most 4 caches per job.`);
  const out = [];
  for (const item of list) {
    if (!object(item)) refuse(`${where}: cache entries are mappings.`);
    const extra = Object.keys(item).filter(key => !['key', 'paths', 'untracked', 'policy', 'when', 'fallback_keys', 'unprotect'].includes(key));
    if (extra.length) refuse(`${where}: cache:${extra[0]} is not supported.`);
    let key = item.key === undefined ? 'default' : item.key;
    if (object(key)) {
      const extraKey = Object.keys(key).filter(name => !['files', 'prefix'].includes(name));
      if (extraKey.length || !Array.isArray(key.files) || key.files.length < 1 || key.files.length > 2 || key.files.some(file => typeof file !== 'string')) refuse(`${where}: cache:key:files names one or two files.`);
      let content = '';
      for (const file of key.files) { const text = await input.readFile(file.replace(/^\.?\//, '')); content += file + '\0' + (text ?? '') + '\0'; }
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(content)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
      key = (key.prefix !== undefined ? scalar(key.prefix, `${where}: cache:key:prefix`) + '-' : '') + hash;
      input.notes.add('cache:key:files is computed from the files’ content at this commit (GitLab uses the last commit that changed them).');
    } else key = scalar(key, `${where}: cache:key`);
    if (item.paths !== undefined && (!Array.isArray(item.paths) || item.paths.some(path => typeof path !== 'string'))) refuse(`${where}: cache:paths must be a list of paths.`);
    if (item.policy !== undefined && !['pull', 'push', 'pull-push'].includes(item.policy)) refuse(`${where}: cache:policy must be pull, push or pull-push.`);
    if (item.when !== undefined && !whenValues.includes(item.when)) refuse(`${where}: cache:when must be on_success, on_failure or always.`);
    if (item.fallback_keys !== undefined && (!Array.isArray(item.fallback_keys) || item.fallback_keys.length > 5 || item.fallback_keys.some(name => typeof name !== 'string'))) refuse(`${where}: cache:fallback_keys names up to five keys.`);
    out.push({ key, untracked: Boolean(item.untracked), policy: item.policy || 'pull-push', paths: item.paths || [], when: item.when || 'on_success', fallback_keys: item.fallback_keys || [] });
  }
  return out;
}
function retrySpec(value, where) {
  if (value === undefined || value === null) return 0;
  if (Number.isInteger(value)) { if (value < 0 || value > 2) refuse(`${where}: retry must be 0, 1 or 2.`); return value; }
  if (!object(value)) refuse(`${where}: retry must be a number or a mapping.`);
  const extra = Object.keys(value).filter(key => !['max', 'when'].includes(key));
  if (extra.length) refuse(`${where}: retry:${extra[0]} is not supported.`);
  if (value.when !== undefined && ![value.when].flat().every(reason => reason === 'always')) refuse(`${where}: retry:when other than always is not supported; Golf retries any failure.`);
  return retrySpec(value.max ?? 0, where);
}
function timeoutSpec(value, where) {
  if (value === undefined || value === null) return undefined;
  const seconds = duration(value, `${where}: timeout`);
  if (seconds < 60 || seconds > 21600) refuse(`${where}: timeout must be between 1 minute and 6 hours on Golf.`);
  return seconds;
}
function parallelSpec(value, where) {
  if (value === undefined || value === null) return null;
  if (Number.isInteger(value)) { if (value < 1 || value > limits.parallel) refuse(`${where}: parallel must be 1 to ${limits.parallel}.`); return Array.from({ length: value }, (_, i) => ({ suffix: ` ${i + 1}/${value}`, variables: {}, index: i + 1, total: value })); }
  if (!object(value) || Object.keys(value).some(key => key !== 'matrix') || !Array.isArray(value.matrix) || !value.matrix.length) refuse(`${where}: parallel must be a number or parallel:matrix.`);
  const combos = [];
  for (const entry of value.matrix) {
    if (!object(entry) || !Object.keys(entry).length) refuse(`${where}: each parallel:matrix entry maps variables to values.`);
    let partial = [[]];
    for (const [name, raw] of Object.entries(entry)) {
      if (!variableName.test(name)) refuse(`${where}: invalid matrix variable ${quote(name)}.`);
      const values = [raw].flat().map(item => scalar(item, `${where}: parallel:matrix:${name}`));
      partial = partial.flatMap(prefix => values.map(item => [...prefix, [name, item]]));
      if (partial.length > limits.parallel) refuse(`${where}: parallel:matrix expands to more than ${limits.parallel} jobs.`);
    }
    combos.push(...partial);
  }
  if (combos.length > limits.parallel) refuse(`${where}: parallel:matrix expands to more than ${limits.parallel} jobs.`);
  return combos.map((pairs, i) => ({ suffix: `: [${pairs.map(pair => pair[1]).join(', ')}]`, variables: Object.fromEntries(pairs), index: i + 1, total: combos.length }));
}
// environment → a Golf native environment: name/url/action/deployment_tier; GitLab-agent and auto-stop features refuse.
const tiers = ['production', 'staging', 'testing', 'development', 'other'];
function environmentSpec(value, where, lookup) {
  if (value === undefined || value === null) return null;
  const spec = typeof value === 'string' ? { name: value } : value;
  if (!object(spec)) refuse(`${where}: environment must be a name or a mapping.`);
  const extra = Object.keys(spec).filter(key => !['name', 'url', 'action', 'deployment_tier'].includes(key));
  if (extra.length) refuse(`${where}: environment:${extra[0]} is not supported (Golf supports environment name, url, action and deployment_tier).`);
  const name = expand(scalar(spec.name ?? '', `${where}: environment:name`), lookup).trim();
  if (!name || name.length > 255 || !/^[A-Za-z0-9 _./-]+$/.test(name) || name.startsWith('/') || name.endsWith('/')) refuse(`${where}: invalid environment name ${quote(name)} (letters, digits, space, _ . / -).`);
  const url = spec.url === undefined ? '' : expand(scalar(spec.url, `${where}: environment:url`), lookup).trim();
  if (url && (url.length > 2048 || !/^https?:\/\/[^\s]+$/.test(url))) refuse(`${where}: environment:url must be an http(s) URL.`);
  const action = spec.action ?? 'start';
  if (!['start', 'prepare', 'stop', 'verify', 'access'].includes(action)) refuse(`${where}: environment:action must be start, prepare, stop, verify or access.`);
  const tier = spec.deployment_tier ?? (/^prod/i.test(name) ? 'production' : /^(stag|model|pre)/i.test(name) ? 'staging' : /^(test|qa)/i.test(name) ? 'testing' : /^(dev|review|trunk)/i.test(name) ? 'development' : 'other');
  if (!tiers.includes(tier)) refuse(`${where}: environment:deployment_tier must be one of ${tiers.join(', ')}.`);
  return { name, url, action, tier };
}
function inheritSpec(value, where) {
  const out = { default: true, variables: true };
  if (value === undefined) return out;
  if (!object(value) || Object.keys(value).some(key => !['default', 'variables'].includes(key))) refuse(`${where}: inherit supports default and variables.`);
  for (const key of ['default', 'variables']) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item === 'boolean' || Array.isArray(item) && item.every(name => typeof name === 'string')) out[key] = item;
    else refuse(`${where}: inherit:${key} must be a boolean or a list.`);
  }
  return out;
}
const inherits = (setting, key) => setting === true || Array.isArray(setting) && setting.includes(key);

// ---------- plan ----------
// input = { source, readFile(path) → string|null, files: string[]|null, changedFiles: string[]|null,
//           context: { event, ref, commitId, beforeSha, defaultBranch, projectPath, pullNumber, headRef, baseRef, origin, commitMessage, variables } }
// → { workflowName, jobs, notes } | { skipped: reason }; Fault(invalid_argument) when the configuration is unsupported or invalid.
export async function gitLabPipelinePlan(input) {
  const context = input?.context || {};
  if (typeof input?.readFile !== 'function') throw Error('gitLabPipelinePlan needs readFile');
  if (!['push', 'merge_request_event', 'web', 'schedule'].includes(context.event)) refuse(`GitLab pipelines run for push, merge request, web and schedule events, not ${quote(context.event)}.`);
  const notes = new Set();
  const state = { seen: new Set([gitLabPipelinePath]), total: size(String(input.source ?? '')) };
  const predefined = pipelineVariables(context);
  const pipelineVars = variables(context.variables || {}, 'Pipeline variables');
  const work = { readFile: input.readFile, files: Array.isArray(input.files) ? input.files : null, changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : null, notes };
  // Include rules see predefined and pipeline variables only (like GitLab, before the YAML is merged).
  work.lookup = name => pipelineVars[name]?.value ?? predefined[name];
  let config = await includes(load(input.source, gitLabPipelinePath), gitLabPipelinePath, work, state, 0);
  config = references(config);
  for (const key of Object.keys(config)) if (key in refusedJobKeys && !object(config[key])) refuse(`Top-level ${key} is not supported.`);
  if ('spec' in config) refuse('spec:inputs headers are not supported.');
  const globalVars = variables(config.variables, 'variables', true);
  const defaults = {};
  for (const key of ['image', 'services', 'before_script', 'after_script', 'cache']) if (config[key] !== undefined) defaults[key] = config[key];
  if (config.default !== undefined) {
    if (!object(config.default)) refuse('default must be a mapping.');
    for (const key of Object.keys(config.default)) {
      if (key === 'hooks' || key === 'id_tokens') refuse(`default:${key} is not supported.`);
      if (!defaultKeys.includes(key)) refuse(`default:${key} is not a valid default keyword.`);
    }
    Object.assign(defaults, config.default);
  }
  if (config.stages !== undefined && config.types !== undefined) refuse('Use stages, not both stages and types.');
  const declared = config.stages ?? config.types ?? ['build', 'test', 'deploy'];
  if (!Array.isArray(declared) || declared.some(stage => typeof stage !== 'string' || !stage) || declared.length > 50) refuse('stages must be a list of names.');
  const stages = ['.pre', ...declared.filter(stage => stage !== '.pre' && stage !== '.post'), '.post'];

  // workflow
  let workflowName = '', workflowVars = {};
  const lookupWith = (...maps) => name => { for (const map of maps) if (map[name] !== undefined) return map[name]?.value ?? map[name]; return predefined[name]; };
  if (config.workflow !== undefined) {
    if (!object(config.workflow)) refuse('workflow must be a mapping.');
    const extra = Object.keys(config.workflow).filter(key => !['rules', 'name'].includes(key));
    if (extra.length) refuse(`workflow:${extra[0]} is not supported.`);
    if (config.workflow.rules !== undefined) {
      work.lookup = lookupWith(pipelineVars, globalVars);
      const rule = await rulesDecision(config.workflow.rules, 'workflow', work.lookup, work, ['if', 'changes', 'exists', 'when', 'variables']);
      if (!rule) return { skipped: 'workflow:rules did not match this pipeline.' };
      if (rule.when !== undefined && !['always', 'never'].includes(rule.when)) refuse('workflow:rules:when must be always or never.');
      if (rule.when === 'never') return { skipped: 'workflow:rules excluded this pipeline (when: never).' };
      workflowVars = variables(rule.variables, 'workflow:rules:variables');
    }
    if (config.workflow.name !== undefined) workflowName = expand(scalar(config.workflow.name, 'workflow:name'), lookupWith(pipelineVars, workflowVars, globalVars)).slice(0, 255);
  }
  const effectiveGlobals = { ...globalVars, ...workflowVars };

  // jobs
  const defined = new Map();
  for (const [name, value] of Object.entries(config)) {
    if (topKeys.includes(name) || name === 'spec') continue;
    if (name.startsWith('.')) continue;
    if (!object(value)) refuse(`${quote(name)} is not a job (jobs are mappings) and not a known keyword.`);
    if (name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) refuse(`Invalid job name ${quote(name)}.`);
    defined.set(name, extendsJob(config, name));
  }
  if (!defined.size) refuse('The configuration has no visible jobs.');
  const kept = [];
  for (const [name, job] of defined) {
    const where = `job ${quote(name)}`;
    for (const key of Object.keys(job)) if (!jobKeys.includes(key) && !(key in refusedJobKeys)) refuse(`${where}: unknown keyword ${quote(key)}.`);
    const inherit = inheritSpec(job.inherit, where);
    const jobGlobals = Object.fromEntries(Object.entries(effectiveGlobals).filter(([key]) => inherits(inherit.variables, key)));
    const jobVars = variables(job.variables, where);
    const stage = job.stage ?? 'test';
    if (!stages.includes(stage)) refuse(`${where}: stage ${quote(stage)} is not declared in stages.`);
    if (job.rules !== undefined && (job.only !== undefined || job.except !== undefined)) refuse(`${where}: rules cannot be combined with only/except.`);
    const lookup = lookupWith(pipelineVars, jobVars, jobGlobals);
    work.lookup = lookup;
    let when = job.when ?? 'on_success', allowFailure = job.allow_failure, ruleVars = {}, ruleNeeds;
    if (!['on_success', 'on_failure', 'always', 'manual', 'never', 'delayed'].includes(when)) refuse(`${where}: when must be on_success, on_failure, always, manual or never.`);
    if (when === 'delayed') refuse(`${where}: when: delayed is not supported.`);
    let manualDefaultAllow = true;
    if (job.rules !== undefined) {
      const rule = await rulesDecision(job.rules, where, lookup, work);
      if (!rule) continue;
      if (rule.when !== undefined) {
        if (!['on_success', 'on_failure', 'always', 'manual', 'never', 'delayed'].includes(rule.when)) refuse(`${where}: rules:when ${quote(rule.when)} is not valid.`);
        if (rule.when === 'delayed') refuse(`${where}: rules:when: delayed is not supported.`);
        when = rule.when;
      }
      if (rule.allow_failure !== undefined) allowFailure = rule.allow_failure;
      ruleVars = variables(rule.variables, `${where}: rules:variables`);
      if (rule.needs !== undefined) ruleNeeds = rule.needs;
      manualDefaultAllow = false;
    } else {
      // Without only, GitLab's default is only: [branches, tags] (so merge request pipelines need rules or only: [merge_requests]).
      if (!await onlyExcept(job.only ?? ['branches', 'tags'], where, 'only', { vars: predefined, event: context.event }, work)) continue;
      if (job.except !== undefined && await onlyExcept(job.except, where, 'except', { vars: predefined, event: context.event }, work)) continue;
    }
    if (when === 'never') continue;
    // Unsupported features refuse the pipeline only when the job would actually be part of it.
    for (const key of Object.keys(job)) if (key in refusedJobKeys) refuse(`${where}: ${key} — ${refusedJobKeys[key]}.`);
    if (name === 'pages') refuse(`${where}: GitLab Pages deployment (a job named pages) is not supported on Golf.`);
    if (allowFailure === undefined) allowFailure = when === 'manual' && manualDefaultAllow;
    if (object(allowFailure)) refuse(`${where}: allow_failure:exit_codes is not supported.`);
    if (typeof allowFailure !== 'boolean') refuse(`${where}: allow_failure must be a boolean.`);
    const pick = key => job[key] !== undefined ? job[key] : inherits(inherit.default, key) ? defaults[key] : undefined;
    const script = scriptList(job.script, `${where}: script`);
    if (!script?.length) refuse(`${where}: script is required.`);
    if (job.interruptible !== undefined || defaults.interruptible !== undefined) notes.add('interruptible has no effect: Golf does not auto-cancel redundant pipelines.');
    let coverage = null;
    if (job.coverage !== undefined) {
      const m = typeof job.coverage === 'string' && /^\/(.*)\/([a-z]*)$/s.exec(job.coverage);
      if (!m) refuse(`${where}: coverage must be a /regular expression/.`);
      regex(m[1], m[2]);
      coverage = job.coverage;
    }
    const tags = pick('tags');
    if (tags !== undefined && (!Array.isArray(tags) || tags.length > 16 || tags.some(tag => typeof tag !== 'string' || !tag))) refuse(`${where}: tags must be a list of up to 16 names.`);
    const spec = {
      stage, when, allowFailure, coverage,
      image: imageSpec(pick('image'), where), services: servicesSpec(pick('services'), where),
      before: scriptList(pick('before_script'), `${where}: before_script`) || [], script, after: scriptList(pick('after_script'), `${where}: after_script`) || [],
      variables: { ...jobGlobals, ...jobVars, ...ruleVars }, artifacts: artifactsSpec(pick('artifacts'), where, notes) || [], cache: await cacheSpec(pick('cache'), where, work) || [],
      retry: retrySpec(pick('retry'), where), timeout: timeoutSpec(pick('timeout'), where),
      tags: (tags || []).map(tag => expand(tag, lookup)),
      needs: ruleNeeds !== undefined ? ruleNeeds : job.needs, dependencies: job.dependencies,
      parallel: parallelSpec(job.parallel, where),
      environment: environmentSpec(job.environment, where, lookup),
    };
    kept.push({ name, spec, stageIndex: stages.indexOf(stage) });
  }
  if (!kept.length) return { skipped: 'No jobs match this pipeline’s rules.' };
  if (kept.every(job => job.spec.stage === '.pre' || job.spec.stage === '.post')) refuse('A pipeline needs a job outside the .pre and .post stages.');

  // Instances (parallel) and the DAG.
  const instances = new Map();
  for (const job of kept) instances.set(job.name, job.spec.parallel ? job.spec.parallel.map(item => ({ ...item, name: job.name + item.suffix })) : [{ name: job.name, variables: {}, index: 0, total: 0 }]);
  const total = [...instances.values()].reduce((sum, list) => sum + list.length, 0);
  if (total > limits.jobs) refuse(`The pipeline has ${total} jobs; Golf runs at most ${limits.jobs}.`);
  const all = new Map(kept.map(job => [job.name, job]));
  const resolveName = (reference, where, optional) => {
    if (instances.has(reference)) return instances.get(reference).map(item => item.name);
    for (const [base, list] of instances) { const hit = list.find(item => item.name === reference); if (hit) return [hit.name]; void base; }
    if (optional) return [];
    if (defined.has(reference) || [...defined.keys()].some(name => reference.startsWith(name + ':') || reference.startsWith(name + ' '))) refuse(`${where}: ${quote(reference)} is not in this pipeline (excluded by rules); mark the need optional: true.`);
    refuse(`${where}: ${quote(reference)} is not a job of this configuration.`);
  };
  const stageOf = name => all.get([...instances].find(([, list]) => list.some(item => item.name === name))[0]).stageIndex;
  const jobs = [];
  for (const job of kept) {
    const where = `job ${quote(job.name)}`, spec = job.spec;
    let needs = null, artifactNeeds = null;
    if (spec.needs !== undefined && spec.needs !== null) {
      if (!Array.isArray(spec.needs) || spec.needs.length > limits.needs) refuse(`${where}: needs must be a list of at most ${limits.needs} jobs.`);
      needs = []; artifactNeeds = [];
      for (const need of spec.needs) {
        let target, artifacts = true, optional = false, matrix = null;
        if (typeof need === 'string') target = need;
        else if (object(need)) {
          const extra = Object.keys(need).filter(key => !['job', 'artifacts', 'optional', 'parallel'].includes(key));
          if (extra.length) refuse(`${where}: needs:${extra[0]} is not supported (cross-project and parent pipeline needs are not available).`);
          if (typeof need.job !== 'string') refuse(`${where}: needs:job must name a job.`);
          target = need.job; artifacts = need.artifacts !== false; optional = need.optional === true;
          if (need.parallel !== undefined) matrix = parallelSpec(need.parallel, `${where}: needs:parallel`);
        } else refuse(`${where}: needs entries are job names or mappings.`);
        let names = resolveName(target, where, optional);
        if (matrix) { const wanted = new Set(matrix.map(item => target + item.suffix)); names = names.filter(name => wanted.has(name)); if (names.length !== wanted.size) refuse(`${where}: needs:parallel:matrix of ${quote(target)} names jobs that do not exist.`); }
        for (const name of names) {
          if (stageOf(name) > job.stageIndex) refuse(`${where}: needs ${quote(name)}, which is in a later stage.`);
          if (name === job.name || instances.get(job.name).some(item => item.name === name)) refuse(`${where}: a job cannot need itself.`);
          if (!needs.includes(name)) needs.push(name);
          if (artifacts && !artifactNeeds.includes(name)) artifactNeeds.push(name);
        }
      }
    }
    let dependencies;
    if (spec.dependencies !== undefined && spec.dependencies !== null) {
      if (!Array.isArray(spec.dependencies) || spec.dependencies.some(name => typeof name !== 'string')) refuse(`${where}: dependencies must be a list of job names.`);
      dependencies = [];
      for (const reference of spec.dependencies) {
        const known = instances.has(reference) || [...instances.values()].some(list => list.some(item => item.name === reference));
        if (!known) {
          if (defined.has(reference) || [...defined.keys()].some(name => reference.startsWith(name + ':') || reference.startsWith(name + ' '))) { notes.add(`Dependency ${quote(reference)} of ${quote(job.name)} is not in this pipeline and is skipped.`); continue; }
          refuse(`${where}: dependencies names ${quote(reference)}, which is not a job of this configuration.`);
        }
        for (const name of resolveName(reference, where, false)) {
          if (needs ? !needs.includes(name) : stageOf(name) >= job.stageIndex) refuse(`${where}: dependency ${quote(name)} must be ${needs ? 'listed in needs' : 'in an earlier stage'}.`);
          if (!dependencies.includes(name)) dependencies.push(name);
        }
      }
    } else dependencies = artifactNeeds ?? null;
    for (const instance of instances.get(job.name)) {
      const stageNeeds = needs ?? kept.filter(other => other.stageIndex < job.stageIndex).flatMap(other => instances.get(other.name).map(item => item.name));
      const deps = dependencies ?? stageNeeds;
      const variablesOut = { ...spec.variables, ...Object.fromEntries(Object.entries(instance.variables).map(([key, value]) => [key, { value, raw: false }])) };
      if (instance.total) Object.assign(variablesOut, { CI_NODE_INDEX: { value: String(instance.index), raw: false }, CI_NODE_TOTAL: { value: String(instance.total), raw: false } });
      const payload = {
        v: gitLabSpecVersion, name: instance.name, stage: spec.stage, image: spec.image || null, services: spec.services || [],
        script: [...spec.before, ...spec.script], after_script: spec.after,
        variables: Object.entries(variablesOut).map(([key, entry]) => ({ key, value: entry.value, raw: entry.raw })),
        artifacts: spec.artifacts, cache: spec.cache, dependencies: deps, coverage: spec.coverage,
        ...(spec.environment ? { environment: spec.environment } : {}),
      };
      const text = JSON.stringify(payload);
      if (size(text) > limits.payload) refuse(`${quote(instance.name)}: the job definition exceeds ${limits.payload / 1024} KiB.`);
      jobs.push({ key: instance.name, name: instance.name, stage: spec.stage, stageIndex: job.stageIndex, needs: stageNeeds, runsOn: spec.tags, payload: text,
        when: spec.when, allowFailure: spec.allowFailure, timeoutSeconds: spec.timeout, retryMax: spec.retry,
        ...(spec.environment ? { environment: { name: spec.environment.name, url: spec.environment.url, action: spec.environment.action } } : {}) });
    }
  }
  // Cycles are impossible: needs only point to the same or earlier stages, and same-stage needs are checked here.
  const order = new Map(jobs.map(job => [job.key, job]));
  const visiting = new Set(), done = new Set();
  const visit = key => {
    if (done.has(key)) return;
    if (visiting.has(key)) refuse(`needs form a cycle through ${quote(key)}.`);
    visiting.add(key); for (const need of order.get(key).needs) visit(need); visiting.delete(key); done.add(key);
  };
  for (const key of order.keys()) visit(key);
  return { workflowName: workflowName || 'GitLab CI', jobs, notes: [...notes] };
}

// Trigger intake (actions-intake.mjs) plans `.gitlab-ci.yml` with this module for every push, merge request and web run.
registerPipelinePlanner('gitlab-ci', gitLabPipelinePath, gitLabPipelinePlan);

// ---------- runner payload ----------
const failureReasons = ['unknown_failure', 'script_failure', 'api_failure', 'stuck_or_timeout_failure', 'runner_system_failure', 'missing_dependency_failure', 'runner_unsupported',
  'stale_schedule', 'job_execution_timeout', 'archived_failure', 'unmet_prerequisites', 'scheduler_failure', 'data_integrity_failure', 'runner_configuration_failure', 'image_pull_failure', 'job_canceled'];
export function gitLabJobSpec(job) {
  let spec;
  try { spec = JSON.parse(job.payload); } catch { spec = null; }
  if (!spec || spec.v !== gitLabSpecVersion) throw new Fault('failed_precondition', 412, 'The job definition is not a GitLab CI job.');
  return spec;
}
// `values` = pipelineValues(); `dependencies` = [{ id, name, size }] archive artifacts; `inherited` = dotenv variables from dependencies.
export function gitLabJobResponse({ env, job, run, repository, token, values, dependencies = [], inherited = {}, gitURL, projectPath }) {
  const spec = gitLabJobSpec(job), origin = env.PUBLIC_ORIGIN;
  const ref = run.ref.startsWith('refs/heads/') ? run.ref.slice(11) : run.ref.startsWith('refs/tags/') ? run.ref.slice(10) : run.head_ref || run.ref;
  const refType = run.ref.startsWith('refs/tags/') ? 'tag' : 'branch';
  const predefined = pipelineVariables({ event: run.event, ref: run.ref, commitId: run.commit_id, beforeSha: run.before_sha, defaultBranch: repository.default_branch,
    projectPath, pullNumber: run.pull_number, headRef: run.head_ref, baseRef: run.base_ref, origin });
  const ordered = new Map();
  const put = (key, value, extra = {}) => { ordered.delete(key); ordered.set(key, { key, value: String(value), public: true, masked: false, ...extra }); };
  for (const [key, value] of Object.entries(predefined)) put(key, value);
  Object.entries({ CI_PROJECT_ID: repository.id, CI_PROJECT_VISIBILITY: repository.is_public ? 'public' : 'private', CI_PIPELINE_ID: run.id, CI_PIPELINE_IID: run.number,
    CI_PIPELINE_URL: `${origin}/${projectPath}/-/pipelines/${run.id}`, CI_PIPELINE_CREATED_AT: run.created_at, CI_PIPELINE_NAME: run.workflow_name,
    CI_JOB_ID: job.id, CI_JOB_NAME: job.name, CI_JOB_NAME_SLUG: slug(job.name), CI_JOB_STAGE: job.stage, CI_JOB_URL: `${origin}/${projectPath}/-/jobs/${job.id}`,
    CI_JOB_STARTED_AT: job.started_at || new Date().toISOString(), CI_JOB_TIMEOUT: job.timeout_seconds, CI_JOB_MANUAL: job.when_mode === 'manual' ? 'true' : '',
    CI_RUNNER_ID: job.runner_id ?? '', CI_PIPELINE_TRIGGERED: '' }).forEach(([key, value]) => value !== '' && put(key, value));
  if (spec.environment) Object.entries({ CI_ENVIRONMENT_NAME: spec.environment.name, CI_ENVIRONMENT_SLUG: slug(spec.environment.name).slice(0, 24).replace(/-+$/, ''),
    CI_ENVIRONMENT_URL: spec.environment.url, CI_ENVIRONMENT_ACTION: spec.environment.action, CI_ENVIRONMENT_TIER: spec.environment.tier }).forEach(([key, value]) => value && put(key, value));
  for (const entry of spec.variables) put(entry.key, entry.value, entry.raw ? { raw: true } : {});
  for (const [key, value] of Object.entries(inherited)) put(key, value);
  for (const [key, value] of Object.entries(values?.variables || {})) put(key, value);
  for (const [key, value] of Object.entries(values?.secrets || {})) put(key, value, { public: false, masked: true });
  try { for (const [key, value] of Object.entries(JSON.parse(run.inputs || '{}'))) if (variableName.test(key) && typeof value === 'string') put(key, value); } catch { /* inputs are written by intake as JSON */ }
  // Credentials and identity cannot be overridden by repository or pipeline variables.
  put('CI_JOB_TOKEN', token, { public: false, masked: true });
  put('CI_REPOSITORY_URL', gitURL.replace('://', '://gitlab-ci-token:[MASKED]@'), { public: false });
  put('CI_BUILD_TOKEN', token, { public: false, masked: true });
  const timeout = job.timeout_seconds;
  return {
    id: job.id, token, allow_git_fetch: true,
    job_info: { id: job.id, name: job.name, stage: job.stage, project_id: repository.id, project_name: repository.name, project_full_path: projectPath, time_in_queue_seconds: 0 },
    git_info: { repo_url: gitURL.replace('://', '://gitlab-ci-token:' + token + '@'), repo_object_format: 'sha1', ref, sha: run.commit_id, before_sha: run.before_sha || '0'.repeat(40), ref_type: refType,
      refspecs: [`+${run.commit_id}:refs/${refType === 'tag' ? 'tags' : 'remotes/origin'}/${ref}`], depth: 50 },
    runner_info: { timeout, runner_session_url: '' },
    variables: [...ordered.values()],
    steps: [
      { name: 'script', script: spec.script, timeout, when: 'on_success', allow_failure: false },
      ...(spec.after_script.length ? [{ name: 'after_script', script: spec.after_script, timeout: Math.min(timeout, 300), when: 'always', allow_failure: true }] : []),
    ],
    image: spec.image || { name: env.GITLAB_DEFAULT_IMAGE || 'alpine:3.23' },
    services: spec.services, artifacts: spec.artifacts, cache: spec.cache, credentials: [],
    dependencies: dependencies.map(item => ({ id: item.id, name: item.name, token, artifacts_file: { filename: 'artifacts.zip', size: item.size } })),
    features: { trace_sections: true, failure_reasons: failureReasons },
  };
}
