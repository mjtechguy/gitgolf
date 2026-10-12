import languages from '../data/languages.json' with { type: 'json' };
import { sha } from './git.mjs';
export const classifierVersion = 'linguist-filenames-20261009-v3';

const extensions = new Map(), filenames = new Map();
for (const [name, value] of Object.entries(languages)) {
  for (const extension of value.extensions || []) if (!extensions.has(extension.toLowerCase())) extensions.set(extension.toLowerCase(), name);
  for (const filename of value.filenames || []) if (!filenames.has(filename)) filenames.set(filename, name);
}
// Common ambiguous suffixes use the same stable default on every runtime.
for (const [extension, name] of [['.html', 'HTML'], ['.htm', 'HTML'], ['.css', 'CSS'], ['.c', 'C'], ['.cpp', 'C++'], ['.cc', 'C++'], ['.cs', 'C#'], ['.java', 'Java'], ['.sh', 'Shell'], ['.rs', 'Rust'], ['.go', 'Go'], ['.js', 'JavaScript'], ['.py', 'Python'], ['.php', 'PHP'], ['.h', 'C'], ['.m', 'Objective-C'], ['.ts', 'TypeScript'], ['.tsx', 'TSX'], ['.jsx', 'JavaScript']]) extensions.set(extension, name);
// Prose/data suffixes can overlap obscure programming languages in the filename map.
for (const extension of ['.md', '.markdown', '.rst', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.csv', '.lock']) extensions.delete(extension);
const generated = /(?:^|\/)(?:vendor|node_modules|third_party|third-party|dist|build|target|coverage|\.next|\.git)(?:\/|$)|(?:\.min\.(?:js|css)|\.pb\.go|\.generated\.[^/]+)$/;
const safePath = path => path.length <= 4096 && !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');

export function attributes(text) {
  const rules = [];
  if (text.length > 64 * 1024) throw Error('Language attributes exceed their bound');
  for (const line of text.split('\n')) {
    const [pattern, ...values] = line.trim().split(/\s+/);
    if (!pattern || pattern.startsWith('#') || pattern.startsWith('!') || pattern.includes('"') || pattern.length > 512) continue;
    const relevant = values.filter(value => /^(?:-)?linguist-(?:language=|vendored|generated|detectable)/.test(value));
    if (relevant.length) rules.push({ pattern, values: relevant });
    if (rules.length > 512) throw Error('Too many language attributes');
  }
  return rules;
}
function matches(pattern, path) {
  const literal = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^(?:${pattern.includes('/') ? '' : '.*/'}${literal}|${literal})$`).test(path);
}
export function language(path, rules = []) {
  if (!safePath(path)) throw Error('Invalid classified source path');
  const filename = path.split('/').at(-1);
  const lower = filename.toLowerCase();
  let result = filenames.get(filename), ignored = generated.test(path) || ['go.mod', 'go.sum'].includes(filename);
  for (let dot = lower.indexOf('.'); !result && dot >= 0; dot = lower.indexOf('.', dot + 1)) result = extensions.get(lower.slice(dot));
  for (const rule of rules) if (matches(rule.pattern, path)) for (const value of rule.values) {
    if (value.startsWith('linguist-language=')) { const name = value.slice('linguist-language='.length).replaceAll('_', ' '); if (Object.hasOwn(languages, name)) result = name; }
    else if (value === '-linguist-detectable' || value === 'linguist-detectable=false' || ['linguist-vendored', 'linguist-vendored=true', 'linguist-generated', 'linguist-generated=true'].includes(value)) ignored = true;
    else if (['-linguist-vendored', 'linguist-vendored=false', '-linguist-generated', 'linguist-generated=false', 'linguist-detectable=true', 'linguist-detectable'].includes(value)) ignored = false;
  }
  return ignored ? undefined : result;
}

export function excludedDirectory(path, rules = []) {
  if (!generated.test(path + '/')) return false;
  return !rules.some(rule => rule.values.some(value => value === '-linguist-vendored' || value === 'linguist-vendored=false' || value === '-linguist-generated' || value === 'linguist-generated=false') && (matches(rule.pattern, path + '/') || rule.pattern.startsWith(path + '/')));
}

export async function textBlob(blob) {
  const prefix = new Uint8Array(await blob.slice(0, 8192).arrayBuffer());
  if (prefix.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: blob.size > prefix.length }); return true; }
  catch { return false; }
}

export function licenseIdentifiers(text) {
  const identifiers = [...text.matchAll(/SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*)/g)].map(match => match[1]);
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  if (normalized.includes('permission is hereby granted, free of charge') && normalized.includes('the above copyright notice and this permission notice shall be included') && normalized.includes('the software is provided "as is"')) identifiers.push('MIT');
  else if (normalized.includes('apache license') && normalized.includes('version 2.0, january 2004') && normalized.includes('terms and conditions for use, reproduction, and distribution')) identifiers.push('Apache-2.0');
  else if (normalized.includes('redistribution and use in source and binary forms') && normalized.includes('this software is provided') && normalized.includes('redistributions of source code must retain')) identifiers.push(normalized.includes('all advertising materials') ? 'BSD-4-Clause' : normalized.includes('neither the name') ? 'BSD-3-Clause' : 'BSD-2-Clause');
  else if (normalized.includes('mozilla public license version 2.0') && normalized.includes('covered software')) identifiers.push('MPL-2.0');
  else if (normalized.includes('permission to use, copy, modify, and/or distribute this software for any purpose with or without fee') && normalized.includes('the software is provided "as is"')) identifiers.push('ISC');
  return [...new Set(identifiers)].filter(value => value.length <= 128).slice(0, 128);
}

export async function rootMetadata(repo, commitId) {
  const commit = await repo.readCommit(commitId);
  if (!commit || !sha(commit.treeHash)) throw Error('Invalid metadata source');
  const tree = await repo.readTree(commit.treeHash);
  if (!tree || tree.length > 10000) throw Error('Metadata root exceeds its bound');
  const licenseIds = [], licensePaths = [];
  let rules = [];
  let inspected = 0;
  for (const entry of tree) {
    if (!['blob', 'exec'].includes(entry.type) || !sha(entry.hash) || !safePath(entry.name) || entry.name.includes('/')) continue;
    if (!/^(?:licen[cs]e|copying|copyright)(?:[._-].*)?$/i.test(entry.name) && entry.name !== '.gitattributes') continue;
    if (++inspected > 17) throw Error('Too many root license files');
    if (entry.name !== '.gitattributes') licensePaths.push(entry.name);
    const blob = await repo.readBlob(entry.hash);
    if (!blob || blob.size > 64 * 1024) continue;
    const text = await blob.text();
    if (entry.name === '.gitattributes') rules = attributes(text);
    else licenseIds.push(...licenseIdentifiers(text));
  }
  return { treeHash: commit.treeHash, licenseIds: [...new Set(licenseIds)], licensePaths: licensePaths.slice(0, 16), rules };
}
