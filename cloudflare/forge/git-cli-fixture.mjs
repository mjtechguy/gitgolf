// A bare repository driven by the real git CLI, plus a repository adapter shaped like the Artifacts handle (readTree/readBlob).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const gitAvailable = spawnSync('git', ['--version']).status === 0;
const types = { '040000': 'tree', '100644': 'blob', '100755': 'exec', '120000': 'symlink', '160000': 'gitlink' };
const modes = { blob: '100644', file: '100644', exec: '100755', executable: '100755', symlink: '120000', gitlink: '160000' };

export function gitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'golf-git-objects-')), directory = join(root, 'repo.git');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '1699990000 +0000', GIT_COMMITTER_DATE: '1699990000 +0000' };
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', directory], { env });
  const run = (args, input, extra = {}) => execFileSync('git', ['--git-dir', directory, ...args], { env: { ...env, ...extra }, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  const text = (...args) => run(...args).toString().trim();
  const blob = content => text(['hash-object', '-w', '--stdin'], content);
  let indexes = 0;
  // ops: {path, content, mode?: file|executable|symlink|gitlink, hash?} or {path, delete: true}; applied by git's own index.
  const edit = (base, ops) => {
    const index = { GIT_INDEX_FILE: join(root, `index-${indexes++}`) };
    if (base) run(['read-tree', base], undefined, index); else run(['read-tree', '--empty'], undefined, index);
    run(['update-index', '--index-info'], ops.map(op => op.delete ? `0 ${'0'.repeat(40)}\t${op.path}\n` : `${modes[op.mode || 'file']} ${op.hash || blob(op.content)}\t${op.path}\n`).join(''), index);
    return text(['write-tree'], undefined, index);
  };
  const tree = files => edit(null, Object.entries(files).map(([path, content]) => typeof content === 'string' ? { path, content } : { path, ...content }));
  const reads = [];
  const repo = {
    async readTree(hash) {
      reads.push(hash);
      const listed = spawnSync('git', ['--git-dir', directory, 'ls-tree', '-z', hash], { env });
      if (listed.status) return null;
      return listed.stdout.toString().split('\0').filter(Boolean).map(line => {
        const [meta, name] = [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)], [mode, , id] = meta.split(' ');
        return { name, type: types[mode], hash: id };
      });
    },
    async readBlob(hash) {
      const read = spawnSync('git', ['--git-dir', directory, 'cat-file', 'blob', hash], { env });
      return read.status ? null : new Blob([read.stdout]);
    },
  };
  // Stores generated objects through git's strict pack indexer, then checks the whole graph from a ref.
  const store = pack => run(['index-pack', '--stdin', '--strict'], pack);
  const verify = (treeId, ref = 'refs/heads/check') => {
    run(['update-ref', ref, text(['commit-tree', treeId, '-m', 'check'])]);
    run(['fsck', '--strict', '--full', '--no-dangling']);
  };
  return { root, directory, env, run, text, blob, edit, tree, repo, reads, store, verify };
}
