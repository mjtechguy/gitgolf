// Exact Git object bytes, packs of many undeltified objects and path-scoped tree edits. Web APIs only.
const encoder = new TextEncoder();
export const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const treeModes = { __proto__: null, tree: '40000', blob: '100644', exec: '100755', symlink: '120000', gitlink: '160000' };
const changeTypes = { __proto__: null, file: 'blob', executable: 'exec', symlink: 'symlink' };
const packTypes = { __proto__: null, commit: 1, tree: 2, blob: 3 };
const objectId = /^[0-9a-f]{40}$/;

// Codes: invalid_path, invalid_change, duplicate_path, path_conflict, missing_path, gitlink_edit, unrepresentable_name.
export class GitTreeError extends Error {
  constructor(code, path, message) { super(message || `${code}: ${path}`); this.name = 'GitTreeError'; this.code = code; this.path = path; }
}
const fail = (code, path, message) => { throw new GitTreeError(code, path, message); };

export function join(...chunks) {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
const sha1 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const raw = id => Uint8Array.from(id.match(/../g), pair => parseInt(pair, 16));

// The object ID is SHA-1 over "<type> <size>\0" and the body.
export async function gitObject(type, body) {
  if (!packTypes[type] || !(body instanceof Uint8Array)) throw TypeError('Invalid Git object');
  return { id: hex(await sha1(join(encoder.encode(`${type} ${body.length}\0`), body))), type, body };
}
export const blobObject = bytes => gitObject('blob', bytes);

// Entries are readTree's shape {name, type, hash}. Git orders names bytewise with directories compared as name + '/'.
export async function treeObject(entries) {
  const names = new Set();
  const rows = entries.map(({ name, type, hash }) => {
    if (!treeModes[type] || !objectId.test(hash) || typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\0]/.test(name) || names.has(name)) throw TypeError('Invalid tree entry');
    // A replacement character means a non-UTF-8 name was decoded lossily; writing it back would rename the entry.
    if (name.includes('\uFFFD')) fail('unrepresentable_name', name, 'The directory holds a name that cannot be rewritten exactly.');
    names.add(name);
    const bytes = encoder.encode(name);
    return { bytes, key: type === 'tree' ? join(bytes, Uint8Array.of(47)) : bytes, mode: encoder.encode(treeModes[type] + ' '), hash: raw(hash) };
  }).sort((a, b) => {
    for (let i = 0; i < a.key.length && i < b.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return a.key.length - b.key.length;
  });
  return gitObject('tree', join(...rows.flatMap(row => [row.mode, row.bytes, Uint8Array.of(0), row.hash])));
}

const signature = ({ name, email, time, tz = '+0000' } = {}) => {
  if (typeof name !== 'string' || typeof email !== 'string' || /[<>\0\n]/.test(name + email) || !Number.isSafeInteger(time) || time < 0 || !/^[+-]\d{4}$/.test(tz)) throw TypeError('Invalid commit identity');
  return `${name} <${email}> ${time} ${tz}`;
};
export async function commitObject({ tree, parents = [], author, committer = author, message }) {
  if (!objectId.test(tree) || !parents.every(parent => objectId.test(parent)) || typeof message !== 'string' || message.includes('\0')) throw TypeError('Invalid commit');
  return gitObject('commit', encoder.encode(`tree ${tree}\n${parents.map(parent => `parent ${parent}\n`).join('')}author ${signature(author)}\ncommitter ${signature(committer)}\n\n${message}`));
}

// Pack v2: header and count, then per object a type/size varint and a zlib stream, then SHA-1 of all preceding bytes.
export async function packObjects(objects) {
  const unique = [...new Map(objects.map((object, index) => [object.id || index, object])).values()];
  const entries = await Promise.all(unique.map(async ({ type, body }) => {
    if (!packTypes[type] || !(body instanceof Uint8Array)) throw TypeError('Invalid pack object');
    const header = []; let size = body.length, byte = packTypes[type] << 4 | size & 15;
    for (size >>>= 4; size; size >>>= 7) { header.push(byte | 0x80); byte = size & 0x7f; }
    header.push(byte);
    return join(Uint8Array.from(header), new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()));
  }));
  const count = unique.length;
  const pack = join(Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, count >>> 24 & 255, count >>> 16 & 255, count >>> 8 & 255, count & 255), ...entries);
  return join(pack, await sha1(pack));
}

// One read per distinct tree for the life of an operation; a missing tree is a repository fault, not a caller error.
export function treeReader(repo) {
  const seen = new Map();
  const read = hash => {
    if (!hash || hash === emptyTree) return Promise.resolve([]);
    if (!seen.has(hash)) seen.set(hash, (async () => { const tree = await repo.readTree(hash); if (!Array.isArray(tree)) throw Error('Missing tree ' + hash); return tree; })());
    return seen.get(hash);
  };
  return read;
}

function segments(path) {
  const parts = typeof path === 'string' ? path.split('/') : [];
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes('\0'))) fail('invalid_path', String(path), 'Use a literal repository path without .git segments.');
  return parts;
}

// changes: {path, content: Uint8Array, mode?: 'file'|'executable'|'symlink'} | {path, delete: true} | {path, from}.
// Omitting mode keeps the mode of the file being replaced. Only directories on changed paths are read; others keep their hashes.
export async function planTreeEdit(repo, baseTreeId, changes) {
  if (!Array.isArray(changes)) fail('invalid_change', '', 'Changes must be a list.');
  const read = treeReader(repo), root = new Map(), objects = new Map(), changedPaths = [], moves = [];
  const place = (path, leaf) => {
    const parts = segments(path); let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.get(part);
      if (next === undefined) node.set(part, next = new Map());
      else if (!(next instanceof Map)) fail('path_conflict', path, 'One change path lies inside another changed path.');
      node = next;
    }
    const last = parts.at(-1);
    if (node.has(last)) fail(node.get(last) instanceof Map ? 'path_conflict' : 'duplicate_path', path, node.get(last) instanceof Map ? 'One change path lies inside another changed path.' : 'A path appears more than once.');
    node.set(last, leaf);
  };
  for (const change of changes) {
    const kinds = ['content', 'delete', 'from'].filter(key => change?.[key] !== undefined);
    if (kinds.length !== 1 || change.mode !== undefined && kinds[0] !== 'content') fail('invalid_change', String(change?.path), 'A change has exactly one of content, delete or from.');
    if (kinds[0] === 'delete') { if (change.delete !== true) fail('invalid_change', String(change.path), 'Delete with delete: true.'); place(change.path, { delete: true }); }
    else if (kinds[0] === 'from') {
      if (change.from === change.path) fail('invalid_change', String(change.path), 'A move needs a different source path.');
      const leaf = { from: change.from }; place(change.from, { delete: true }); place(change.path, leaf); moves.push(leaf);
    } else {
      if (!(change.content instanceof Uint8Array) || change.mode !== undefined && !changeTypes[change.mode]) fail('invalid_change', String(change.path), 'Content must be bytes and mode file, executable or symlink.');
      const blob = await blobObject(change.content);
      place(change.path, { blob, type: changeTypes[change.mode] });
    }
  }
  // A move takes the source entry's blob hash and mode; the source itself is removed by its delete leaf.
  await Promise.all(moves.map(async leaf => {
    const parts = segments(leaf.from); let entries = await read(baseTreeId);
    for (const [index, part] of parts.entries()) {
      const entry = entries.find(item => item.name === part);
      if (entry?.type === 'gitlink') fail('gitlink_edit', leaf.from, 'Submodule entries cannot be edited.');
      if (index === parts.length - 1) {
        if (!entry) fail('missing_path', leaf.from, 'The path to move does not exist.');
        if (entry.type === 'tree') fail('path_conflict', leaf.from, 'Only files can be moved.');
        leaf.type = entry.type; leaf.hash = entry.hash;
      } else if (entry?.type !== 'tree') fail('missing_path', leaf.from, 'The path to move does not exist.');
      else entries = await read(entry.hash);
    }
  }));
  const apply = async (node, treeId, prefix) => {
    const entries = new Map((await read(treeId)).map(entry => [entry.name, entry]));
    let dirty = false;
    await Promise.all([...node].map(async ([name, leaf]) => {
      const path = prefix + name, existing = entries.get(name);
      if (existing?.type === 'gitlink') fail('gitlink_edit', path, 'Submodule entries cannot be edited.');
      if (leaf instanceof Map) {
        if (existing && existing.type !== 'tree') fail('path_conflict', path, 'A file exists where a directory is needed.');
        const hash = await apply(leaf, existing?.hash, path + '/');
        if (hash === existing?.hash) return;
        dirty = true;
        if (hash) entries.set(name, { name, type: 'tree', hash }); else entries.delete(name);
      } else if (leaf.delete) {
        if (!existing) fail('missing_path', path, 'The path to delete does not exist.');
        if (existing.type === 'tree') fail('path_conflict', path, 'Only files can be deleted.');
        entries.delete(name); dirty = true; changedPaths.push({ path, change: 'deleted' });
      } else {
        if (existing?.type === 'tree') fail('path_conflict', path, 'A directory exists where a file is needed.');
        const hash = leaf.blob?.id || leaf.hash, type = leaf.type || existing?.type || 'blob';
        if (existing?.hash === hash && existing.type === type) return;
        if (leaf.blob && existing?.hash !== hash) objects.set(hash, leaf.blob);
        entries.set(name, { name, type, hash }); dirty = true; changedPaths.push({ path, change: existing ? 'modified' : 'added' });
      }
    }));
    if (!dirty) return treeId || null;
    if (!entries.size) return null;
    const tree = await treeObject([...entries.values()]);
    if (tree.id !== treeId) objects.set(tree.id, tree);
    return tree.id;
  };
  let treeId = root.size ? await apply(root, baseTreeId, '') : baseTreeId || null;
  if (!treeId) { const tree = await treeObject([]); objects.set(tree.id, tree); treeId = tree.id; }
  return { treeId, objects: [...objects.values()], changedPaths: changedPaths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
