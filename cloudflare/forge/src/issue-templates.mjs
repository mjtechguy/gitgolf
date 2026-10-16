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
import { parseDocument, visit, isAlias, isMap, isScalar, isSeq } from '../../agents/node_modules/yaml/browser/index.js';
import { Fault, invalid } from './common.mjs';
import { sha } from './git.mjs';

// Same sources, limits and refusals as internal/server/issue_templates.go and
// issue_form_templates.go. A template that cannot be rendered exactly is counted.
const size = value => new TextEncoder().encode(value).length;
const text = (value, limit) => size(value) <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value);
const named = value => value !== '' && size(value) <= 1024 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const refuse = () => { throw Error('Unsupported issue template'); };
const empty = node => node === undefined || node === null || isScalar(node) && node.value === null;

function parse(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) refuse();
  // The portable parser adds no line break to a block scalar that ends the source without one.
  if (!source.endsWith('\n')) visit(document, { Scalar(_, node) { if (node.type?.startsWith('BLOCK_') && node.range[1] >= source.length && node.value.endsWith('\n')) node.value = node.value.slice(0, -1); } });
  return document.contents;
}
// The portable document node is depth 0, so its root is depth 1.
function safe(node, depth = 1) {
  if (node === undefined || node === null) return true;
  if (depth > 12 || isAlias(node) || node.anchor) return false;
  if (isMap(node)) return node.items.every(pair => safe(pair.key, depth + 1) && safe(pair.value, depth + 1));
  return !isSeq(node) || node.items.every(item => safe(item, depth + 1));
}
// Typed readers follow the portable decoder: a scalar of another type fills a
// string field with its source text, null leaves the zero value and a boolean
// field also takes the YAML 1.1 words. Narrow differences remain. Refused here
// only: aliases in Markdown front matter, merge keys and fractional counts.
// Rendered here only: YAML 1.2 text that YAML 1.1 types otherwise as a dropdown
// option (dates, 1_000, 0b1) and documents with a %YAML 1.2 directive.
function fields(node, allowed) {
  const result = new Map();
  if (empty(node)) return result;
  if (!isMap(node)) refuse();
  for (const pair of node.items) {
    if (!isScalar(pair.key)) refuse();
    if (typeof pair.key.value === 'string' && (!allowed || allowed.includes(pair.key.value))) result.set(pair.key.value, pair.value);
    else if (allowed) refuse();
  }
  return result;
}
function string(node) {
  if (empty(node)) return '';
  if (!isScalar(node)) refuse();
  return typeof node.value === 'string' ? node.value : String(node.source ?? node.value);
}
function flag(node) {
  if (empty(node)) return false;
  if (isScalar(node) && typeof node.value === 'boolean') return node.value;
  if (!isScalar(node) || !/^(y|Y|yes|Yes|YES|on|On|ON|n|N|no|No|NO|off|Off|OFF)$/.test(node.value)) refuse();
  return /^[yY]|^[oO][nN]$/.test(node.value);
}
function count(node) {
  if (empty(node)) return undefined;
  if (!isScalar(node) || !Number.isInteger(node.value) || node.value < 0 || node.value > 4294967295) refuse();
  return node.value;
}
const described = template => named(template.name) && text(template.about, 1024) && text(template.title, 255) && template.title.trim() === template.title;

function markdownTemplate(entry, source) {
  const template = { path: entry.path, name: entry.name.replace(/\.[^.]*$/, ''), about: '', title: '', body: source, blobId: entry.hash, fields: [] };
  const normalized = source.replaceAll('\r\n', '\n');
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---\n', 4);
    if (end < 0 || size(normalized.slice(4, end)) > 4096) refuse();
    const front = fields(parse(normalized.slice(4, end)));
    Object.assign(template, { name: string(front.get('name')) || template.name, about: string(front.get('about')), title: string(front.get('title')), body: normalized.slice(end + 5) });
  }
  if (!described(template)) refuse();
  return template;
}

function formTemplate(entry, source) {
  const root = parse(source);
  if (!isMap(root) || !safe(root)) refuse();
  const top = fields(root, ['name', 'description', 'about', 'title', 'labels', 'assignees', 'projects', 'body']);
  const description = string(top.get('description')), about = string(top.get('about')), body = top.get('body');
  const template = { path: entry.path, name: string(top.get('name')), about: description || about, title: string(top.get('title')), body: '', blobId: entry.hash, fields: [] };
  if (!described(template) || !isSeq(body) || !body.items.length || body.items.length > 30) refuse();
  const seen = new Set(); let inputs = 0;
  for (const [index, node] of body.items.entries()) {
    const item = fields(node, ['type', 'id', 'attributes', 'validations']);
    const attributes = fields(item.get('attributes'), ['label', 'description', 'placeholder', 'value', 'render', 'multiple', 'options', 'default']);
    const validations = fields(item.get('validations'), ['required', 'min_length']);
    const choices = empty(attributes.get('options')) ? [] : isSeq(attributes.get('options')) ? attributes.get('options').items : refuse();
    const preset = count(attributes.get('default'));
    const f = { id: string(item.get('id')) || 'field_' + index, type: string(item.get('type')), label: string(attributes.get('label')), description: string(attributes.get('description')),
      placeholder: string(attributes.get('placeholder')), value: string(attributes.get('value')), required: flag(validations.get('required')), options: [],
      multiple: flag(attributes.get('multiple')), render: string(attributes.get('render')), minLength: count(validations.get('min_length')) || 0, ...(preset === undefined ? {} : { defaultOption: preset }) };
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(f.id) || seen.has(f.id)) refuse();
    seen.add(f.id);
    if (!text(f.description, 1024) || !text(f.placeholder, 1024) || !text(f.value, 6000) || f.minLength > 6000) refuse();
    if (f.type === 'markdown') {
      if (!f.value || f.label || f.required || choices.length || f.multiple || f.render || preset !== undefined || f.minLength) refuse();
      template.fields.push(f); continue;
    }
    inputs++;
    if (!named(f.label)) refuse();
    if (f.type === 'input' || f.type === 'textarea') {
      if (choices.length || f.multiple || preset !== undefined || f.type === 'input' && /[\r\n]/.test(f.value)) refuse();
      if (f.render && (f.type !== 'textarea' || !/^[a-zA-Z0-9_+.-]{1,40}$/.test(f.render))) refuse();
    } else if (f.type === 'dropdown' || f.type === 'checkboxes') {
      if (!choices.length || choices.length > 50 || f.value || f.placeholder || f.render || f.minLength) refuse();
      if (f.type === 'checkboxes' && (f.multiple || preset !== undefined)) refuse();
      for (const choice of choices) {
        let option;
        if (f.type === 'dropdown') {
          if (!isScalar(choice) || typeof choice.value !== 'string') refuse();
          option = { label: choice.value, required: false };
        } else {
          const typed = fields(choice, ['label', 'required']);
          option = { label: string(typed.get('label')), required: flag(typed.get('required')) };
        }
        if (!text(option.label, 1024) || !option.label.trim() || f.options.some(o => o.label === option.label)) refuse();
        f.options.push(option);
      }
      if (preset !== undefined && preset >= f.options.length) refuse();
    } else refuse();
    template.fields.push(f);
  }
  if (!inputs) refuse();
  return template;
}

export function issueTemplate(entry, source) {
  return /\.md$/i.test(entry.name) ? markdownTemplate(entry, source) : formTemplate(entry, source);
}

// artifact supplies the default-branch head; readTree is core's validated tree read.
export async function issueTemplates(row, body, artifact, readTree) {
  if (body.repositoryId !== String(row.id)) invalid('Select the exact repository.');
  return artifact(async (repo, _info, commits) => {
    const head = commits[0]?.hash;
    if (!head) return { templates: [], commitId: '', unsupportedTemplates: 0 };
    const commit = sha(head) ? await repo.readCommit(head) : null;
    if (!commit || !sha(commit.treeHash)) throw Error('Invalid default branch identity');
    const root = await readTree(repo, commit.treeHash), parents = [], entries = [];
    const regular = entry => ['blob', 'exec'].includes(entry?.type);
    for (const name of ['.forgejo', '.github']) {
      const parent = root.find(entry => entry.name === name);
      parents.push([name + '/', parent?.type === 'tree' ? await readTree(repo, parent.hash) : []]);
    }
    for (const [prefix, parent] of parents) {
      const directory = parent.find(entry => entry.name === 'ISSUE_TEMPLATE');
      if (directory?.type === 'tree') for (const entry of await readTree(repo, directory.hash)) if (regular(entry)) entries.push({ ...entry, path: prefix + 'ISSUE_TEMPLATE/' + entry.name });
    }
    for (const [prefix, parent] of [...parents, ['', root]]) {
      const entry = parent.find(entry => entry.name === 'ISSUE_TEMPLATE.md');
      if (regular(entry)) entries.push({ ...entry, path: prefix + 'ISSUE_TEMPLATE.md' });
    }
    if (entries.length > 50) throw new Fault('resource_exhausted', 429, 'The default branch has more than 50 issue template files.');
    const templates = []; let unsupportedTemplates = 0;
    for (const entry of entries) {
      if (!/\.(md|ya?ml)$/i.test(entry.name) || ['config.yml', 'config.yaml'].includes(entry.name)) continue;
      const blob = await repo.readBlob(entry.hash);
      if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 0) throw Error('Invalid issue template blob');
      // Provider failures above stay errors; only the bounded parse below is counted.
      const bytes = blob.size > 6000 ? null : await blob.arrayBuffer();
      try {
        const source = bytes && new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (typeof source !== 'string' || !text(source, 6000)) refuse();
        templates.push(issueTemplate(entry, source));
      } catch { unsupportedTemplates++; }
    }
    return { templates, commitId: head, unsupportedTemplates };
  });
}
