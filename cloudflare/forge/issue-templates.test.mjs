import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { digest, handle, concurrentRead } from './src/core.mjs';
import { issueTemplate } from './src/issue-templates.mjs';

const owner = 'golf_native_' + 'a'.repeat(43), reader = 'golf_native_' + 'b'.repeat(43), outsider = 'golf_native_' + 'c'.repeat(43);
const head = 'a'.repeat(40), artifact = 'repo-' + 'd'.repeat(32);
const entry = name => ({ name, path: '.github/ISSUE_TEMPLATE/' + name, hash: 'e'.repeat(40) });
const form = body => 'name: Bug\nbody:\n' + body;

// files maps paths to text, bytes or { symlink }; an undefined tree is an empty repository.
async function fixture(t, files) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login,can_create) VALUES(1,'alice',1),(2,'bob',0),(3,'carol',0); INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','test-space')");
  sql.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','',?,1,'key','hash','ACTIVE','2026-10-14T00:00:00Z')").run(artifact);
  sql.exec("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read')");
  for (const [token, id] of [[owner, 1], [reader, 2], [outsider, 3]]) sql.prepare('INSERT INTO credentials VALUES(?,?,?,0)').run(await digest(token), id, Math.floor(Date.now() / 1000) + 300);
  const DB = { withSession() { return this; }, prepare(query) { const statement = sql.prepare(query); let values = []; return {
    bind(...args) { values = args; return this; }, async first() { return statement.get(...values) || null; },
    async all() { return { results: statement.all(...values) }; }, async run() { return { meta: { changes: statement.run(...values).changes } }; } }; } };
  const trees = new Map(), blobs = new Map(), reads = []; let next = 1;
  const id = () => (next++).toString(16).padStart(40, '0');
  const tree = prefix => {
    const names = new Set(Object.keys(files).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]));
    const hash = id();
    trees.set(hash, [...names].sort().map(name => {
      const value = files[prefix + name];
      if (value === undefined) return { name, hash: tree(prefix + name + '/'), type: 'tree', mode: '40000' };
      const blob = id(); blobs.set(blob, value.symlink ?? value);
      return { name, hash: blob, type: value.symlink ? 'symlink' : 'blob', mode: value.symlink ? '120000' : '100644' };
    }));
    return hash;
  };
  const root = files && tree('');
  const env = { DB, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'test-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: 'https://golf.example.com', ARTIFACTS: { async get(name) { assert.equal(name, artifact); return {
    async info() { return { name, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
    async log(options) { assert.deepEqual(options, { ref: 'main', limit: 1 }); return root ? [{ hash: head, treeHash: root, parents: [] }] : []; },
    async readCommit(hash) { return hash === head ? { hash, treeHash: root, parents: [] } : null; },
    async readTree(hash) { return trees.get(hash) || null; },
    async readBlob(hash) { reads.push(hash); return blobs.has(hash) ? new Blob([blobs.get(hash)]) : null; },
    [Symbol.dispose]() {} }; } } };
  const call = (body = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1' }, token = owner, path = '/rpc/golf.v1.DiscussionCollaborationService/ListIssueTemplates') =>
    handle(new Request(env.PUBLIC_ORIGIN + path, { method: 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body) }), env);
  return { sql, env, call, reads, blob: path => path.split('/').reduce((hash, name) => trees.get(hash).find(e => e.name === name).hash, root) };
}

test('Markdown templates keep portable front matter, naming and refusals', () => {
  assert.deepEqual(issueTemplate(entry('bug.report.MD'), '## Steps\n'), { path: '.github/ISSUE_TEMPLATE/bug.report.MD', name: 'bug.report', about: '', title: '', body: '## Steps\n', blobId: 'e'.repeat(40), fields: [] });
  assert.deepEqual(issueTemplate(entry('bug.md'), '---\r\nname: Bug report\r\nabout: Reproduce a bug\r\ntitle: 123\r\nlabels: bug, triage\r\n---\r\n## Steps\r\n'),
    { path: '.github/ISSUE_TEMPLATE/bug.md', name: 'Bug report', about: 'Reproduce a bug', title: '123', body: '## Steps\n', blobId: 'e'.repeat(40), fields: [] });
  assert.equal(issueTemplate(entry('bug.md'), '---\nabout: only\n---\n').name, 'bug');
  for (const source of ['---\nname: Bug\n', '---\nname: [a]\n---\n', '---\n- list\n---\n', '---\ntitle: " padded"\n---\n', '---\nname: "a\\u0007b"\n---\n', '---\nname: a\nname: b\n---\n',
    '---\nabout: ' + 'a'.repeat(1025) + '\n---\n', '---\n# ' + 'c'.repeat(4096) + '\n---\n']) assert.throws(() => issueTemplate(entry('bug.md'), source), /Unsupported/, source.slice(0, 40));
  assert.throws(() => issueTemplate(entry('.md'), 'no name'), /Unsupported/);
});

test('YAML issue forms produce the portable field contract', () => {
  const source = `name: Structured bug
description: A useful form
about: ignored when a description exists
title: "[Bug]"
labels: [bug, triage]
assignees: octocat
body:
  - type: markdown
    attributes:
      value: Please provide enough detail.
  - type: input
    id: version
    attributes: { label: Version, placeholder: 1.2.3, description: Which release }
    validations: { required: true, min_length: 3 }
  - type: textarea
    attributes: { label: Logs, render: shell, value: "a\\nb" }
  - type: dropdown
    id: platform
    attributes:
      label: Platform
      multiple: true
      options: [Linux, "10"]
      default: 1
  - type: checkboxes
    attributes:
      label: Agreement
      options:
        - label: I checked existing issues.
          required: true
        - label: Optional
`;
  assert.deepEqual(issueTemplate(entry('bug.yml'), source), { path: '.github/ISSUE_TEMPLATE/bug.yml', name: 'Structured bug', about: 'A useful form', title: '[Bug]', body: '', blobId: 'e'.repeat(40), fields: [
    { id: 'field_0', type: 'markdown', label: '', description: '', placeholder: '', value: 'Please provide enough detail.', required: false, options: [], multiple: false, render: '', minLength: 0 },
    { id: 'version', type: 'input', label: 'Version', description: 'Which release', placeholder: '1.2.3', value: '', required: true, options: [], multiple: false, render: '', minLength: 3 },
    { id: 'field_2', type: 'textarea', label: 'Logs', description: '', placeholder: '', value: 'a\nb', required: false, options: [], multiple: false, render: 'shell', minLength: 0 },
    { id: 'platform', type: 'dropdown', label: 'Platform', description: '', placeholder: '', value: '', required: false, options: [{ label: 'Linux', required: false }, { label: '10', required: false }], multiple: true, render: '', minLength: 0, defaultOption: 1 },
    { id: 'field_4', type: 'checkboxes', label: 'Agreement', description: '', placeholder: '', value: '', required: false, options: [{ label: 'I checked existing issues.', required: true }, { label: 'Optional', required: false }], multiple: false, render: '', minLength: 0 },
  ] });
  assert.equal(issueTemplate(entry('bug.yaml'), 'name: Bug\nabout: Fallback\nbody:\n  - type: input\n    attributes: { label: 7 }\n').about, 'Fallback');
  assert.equal(issueTemplate(entry('bug.yaml'), form('  - type: input\n    attributes: { label: 7 }\n')).fields[0].label, '7');
  // Checked against the portable parser: YAML 1.1 boolean words, and no line break added to a final block scalar.
  const words = issueTemplate(entry('bug.yml'), form('  - type: dropdown\n    attributes: { label: A, options: [a], multiple: NO }\n    validations: { required: yes }\n  - type: markdown\n    attributes:\n      value: |\n        Final text')).fields;
  assert.deepEqual([words[0].required, words[0].multiple, words[1].value], [true, false, 'Final text']);
  assert.equal(issueTemplate(entry('bug.md'), '---\nname: Bug\nabout: >\n  Report a\n  problem\n---\nbody').about, 'Report a problem');
});

test('YAML issue forms refuse aliases, anchors and everything outside the bounded contract', () => {
  const input = '  - type: input\n    attributes: { label: A }\n';
  for (const [reason, source] of [
    ['alias', 'name: Bug\nshared: &text Version\nbody:\n  - type: input\n    attributes: { label: *text }\n'],
    ['anchor without alias', form('  - type: input\n    attributes: { label: &kept A }\n')],
    ['anchor inside labels', 'name: Bug\nlabels: &l [bug]\nbody:\n' + input],
    ['depth', 'name: Bug\nlabels: ' + '['.repeat(12) + ']'.repeat(12) + '\nbody:\n' + input],
    ['deep nesting', 'name: Bug\nlabels: ' + '['.repeat(2500) + ']'.repeat(2500) + '\nbody:\n' + input],
    ['unknown top-level key', 'name: Bug\nextra: 1\nbody:\n' + input], ['unknown attribute', form('  - type: input\n    attributes: { label: A, pattern: x }\n')],
    ['unknown validation', form('  - type: input\n    attributes: { label: A }\n    validations: { regex: x }\n')],
    ['duplicate key', 'name: Bug\nname: Other\nbody:\n' + input], ['several documents', form(input) + '---\nname: Second\n'], ['syntax', 'name: [unterminated\n'],
    ['empty document', ''], ['null document', '~\n'], ['sequence document', '- a\n'], ['missing name', 'body:\n' + input], ['empty body', 'name: Bug\nbody: []\n'], ['mapping body', 'name: Bug\nbody: { type: input }\n'],
    ['too many fields', form(input.repeat(31))], ['padded title', 'name: Bug\ntitle: "x "\nbody:\n' + input], ['duplicate id', form('  - type: input\n    id: a\n    attributes: { label: A }\n'.repeat(2))],
    ['invalid id', form('  - type: input\n    id: "a b"\n    attributes: { label: A }\n')], ['unknown type', form('  - type: upload\n    attributes: { label: A }\n')], ['null field', form('  -\n')],
    ['only markdown', form('  - type: markdown\n    attributes: { value: text }\n')], ['empty markdown', form('  - type: markdown\n' + input)], ['labelled markdown', form('  - type: markdown\n    attributes: { value: text, label: A }\n' + input)],
    ['unlabelled input', form('  - type: input\n')], ['multi-line input value', form('  - type: input\n    attributes: { label: A, value: "a\\nb" }\n')], ['input render', form('  - type: input\n    attributes: { label: A, render: shell }\n')],
    ['invalid render', form('  - type: textarea\n    attributes: { label: A, render: "a b" }\n')], ['input options', form('  - type: input\n    attributes: { label: A, options: [a] }\n')],
    ['dropdown without options', form('  - type: dropdown\n    attributes: { label: A }\n')], ['numeric dropdown option', form('  - type: dropdown\n    attributes: { label: A, options: [1] }\n')],
    ['mapping dropdown option', form('  - type: dropdown\n    attributes: { label: A, options: [{ label: a }] }\n')], ['duplicate option', form('  - type: dropdown\n    attributes: { label: A, options: [a, a] }\n')],
    ['blank option', form('  - type: dropdown\n    attributes: { label: A, options: [" "] }\n')], ['default out of range', form('  - type: dropdown\n    attributes: { label: A, options: [a], default: 1 }\n')],
    ['negative default', form('  - type: dropdown\n    attributes: { label: A, options: [a], default: -1 }\n')], ['too many options', form('  - type: dropdown\n    attributes:\n      label: A\n      options: [' + Array.from({ length: 51 }, (_, i) => 'o' + i) + ']\n')],
    ['dropdown placeholder', form('  - type: dropdown\n    attributes: { label: A, options: [a], placeholder: p }\n')], ['scalar checkbox option', form('  - type: checkboxes\n    attributes: { label: A, options: [a] }\n')],
    ['unknown checkbox key', form('  - type: checkboxes\n    attributes: { label: A, options: [{ label: a, extra: 1 }] }\n')], ['multiple checkboxes', form('  - type: checkboxes\n    attributes: { label: A, multiple: true, options: [{ label: a }] }\n')],
    ['string boolean', form('  - type: input\n    attributes: { label: A }\n    validations: { required: "true" }\n')], ['long minimum', form('  - type: input\n    attributes: { label: A }\n    validations: { min_length: 6001 }\n')],
    ['scalar options', form('  - type: dropdown\n    attributes: { label: A, options: a }\n')], ['mapping label', form('  - type: input\n    attributes: { label: { a: b } }\n')],
  ]) assert.throws(() => issueTemplate(entry('bug.yml'), source), reason === 'deep nesting' ? Error : /Unsupported/, reason);
  assert.equal(issueTemplate(entry('bug.yml'), 'name: Bug\nlabels: ' + '['.repeat(11) + ']'.repeat(11) + '\nbody:\n' + input).fields.length, 1);
});

test('templates are listed from the default-branch head with every portable source', async t => {
  const markdown = '---\nname: Bug report\nabout: Reproduce a bug\ntitle: "[Bug]"\n---\n## Steps\n';
  const f = await fixture(t, {
    '.gitea/ISSUE_TEMPLATE/feature.md': 'Describe the feature.\n', '.gitea/ISSUE_TEMPLATE.md': 'Gitea single.\n',
    '.github/ISSUE_TEMPLATE/bug.md': markdown, '.github/ISSUE_TEMPLATE/form.yml': form('  - type: input\n    attributes: { label: Version }\n'),
    '.github/ISSUE_TEMPLATE/config.yml': 'blank_issues_enabled: false\n', '.github/ISSUE_TEMPLATE/notes.txt': 'not a template', '.github/ISSUE_TEMPLATE/linked.md': { symlink: 'bug.md' },
    '.github/ISSUE_TEMPLATE/nested/deep.md': 'ignored', '.github/ISSUE_TEMPLATE/large.md': 'x'.repeat(6001), '.github/ISSUE_TEMPLATE/limit.md': 'x'.repeat(6000),
    '.github/ISSUE_TEMPLATE/alias.yaml': 'name: Bug\nshared: &text Version\nbody:\n  - type: input\n    attributes: { label: *text }\n',
    '.github/ISSUE_TEMPLATE/binary.md': new Uint8Array([0xff, 0xfe, 0x00]), '.github/ISSUE_TEMPLATE/control.md': 'a\u0007b',
    '.github/ISSUE_TEMPLATE.md': 'GitHub single.\n', 'ISSUE_TEMPLATE.md': 'Root single.\n', 'docs/ISSUE_TEMPLATE/elsewhere.md': 'ignored',
  });
  assert.equal(concurrentRead(new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.DiscussionCollaborationService/ListIssueTemplates', { method: 'POST' })), true);
  const response = await f.call(); assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert.equal(data.commitId, head); assert.equal(data.unsupportedTemplates, 4);
  assert.deepEqual(data.templates.map(row => [row.path, row.name]), [['.gitea/ISSUE_TEMPLATE/feature.md', 'feature'], ['.github/ISSUE_TEMPLATE/bug.md', 'Bug report'], ['.github/ISSUE_TEMPLATE/form.yml', 'Bug'],
    ['.github/ISSUE_TEMPLATE/limit.md', 'limit'], ['.gitea/ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE'], ['.github/ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE'], ['ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE']]);
  const bug = data.templates[1];
  assert.deepEqual(bug, { path: '.github/ISSUE_TEMPLATE/bug.md', name: 'Bug report', about: 'Reproduce a bug', title: '[Bug]', body: '## Steps\n', blobId: f.blob('.github/ISSUE_TEMPLATE/bug.md'), fields: [] });
  assert.equal(data.templates[2].fields[0].label, 'Version'); assert.equal(data.templates[3].body.length, 6000);
  // Configuration, other extensions, symlinks and nested directories are never read.
  for (const path of ['.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/notes.txt', '.github/ISSUE_TEMPLATE/linked.md']) assert.equal(f.reads.includes(f.blob(path)), false, path);
  assert.equal((await (await f.call(undefined, reader)).json()).templates.length, 7);
  const capabilities = await (await f.call({}, owner, '/rpc/golf.v1.CapabilityService/ListCapabilities')).json();
  assert.deepEqual(capabilities.capabilities.filter(row => row.id === 'discussion.templates'), [{ id: 'discussion.templates', label: 'Issue templates', state: 'CAPABILITY_STATE_READY',
    reason: 'Markdown and YAML issue forms read from the default branch. At most 50 templates of 6,000 bytes; unsupported or oversized templates are counted, not rendered.' }]);
});

test('an empty repository and a repository without templates list nothing', async t => {
  const empty = await fixture(t); let response = await empty.call();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { templates: [], commitId: '', unsupportedTemplates: 0 }); assert.deepEqual(empty.reads, []);
  const plain = await fixture(t, { 'README.md': 'hello', '.github': 'a file, not a directory', 'ISSUE_TEMPLATE.md/readme': 'a directory, not a file' }); response = await plain.call();
  assert.deepEqual(await response.json(), { templates: [], commitId: head, unsupportedTemplates: 0 }); assert.deepEqual(plain.reads, []);
});

test('more than 50 template files are refused instead of partially listed', async t => {
  const files = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`.github/ISSUE_TEMPLATE/t${i}.md`, 'body ' + i]));
  assert.equal((await (await (await fixture(t, files)).call()).json()).templates.length, 50);
  const f = await fixture(t, { ...files, 'ISSUE_TEMPLATE.md': 'one more' }), response = await f.call();
  assert.equal(response.status, 429); assert.equal((await response.json()).code, 'resource_exhausted'); assert.deepEqual(f.reads, []);
});

test('templates require a current repository grant, even for public source', async t => {
  const f = await fixture(t, { 'ISSUE_TEMPLATE.md': 'PRIVATE TEMPLATE' });
  const target = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1' };
  const refused = async (status, ...args) => { const response = await f.call(...args), body = await response.text(); assert.equal(response.status, status, body); assert.equal(body.includes('PRIVATE TEMPLATE'), false); };
  await refused(401, target, ''); await refused(404, target, outsider);
  f.env.PUBLIC_REPOSITORIES = 'true'; f.sql.exec('INSERT INTO repository_visibility(repository_id,is_public,version) VALUES(1,1,1)');
  // The public source contract still serves this repository to anonymous readers.
  const source = await f.call(target, '', '/rpc/golf.v1.RepositoryService/GetRepository'); assert.equal(source.status, 200, await source.clone().text());
  await refused(401, target, ''); await refused(404, target, outsider);
  await refused(404, { ...target, repositoryId: '2' }); await refused(404, { ...target, repository: { owner: 'bob', name: 'project' } }); await refused(400, { repository: target.repository });
  assert.deepEqual(f.reads, []);
  f.sql.exec('DELETE FROM grants WHERE user_id=2'); await refused(404, target, reader);
  assert.equal((await (await f.call(target)).json()).templates[0].body, 'PRIVATE TEMPLATE');
});
