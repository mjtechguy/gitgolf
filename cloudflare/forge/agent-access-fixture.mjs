// Shared by the API token and remote MCP tests (docs/AGENT_ACCESS.md): node:sqlite as D1 over the real schema, a two-commit
// in-memory Artifacts repository (main and feature differ in one file) and a Smart HTTP provider that applies receive-pack commands.
import { objectFixture, origin, repository } from './object-fixture.mjs';
import { handle, serialize, admission } from './src/core.mjs';
import { packetLine } from './src/git.mjs';

export { origin, repository };
export const base = 'a'.repeat(40), feature = 'b'.repeat(40), zero = '0'.repeat(40);
const trees = new Map([['1'.repeat(40), [{ name: 'hello.txt', hash: '3'.repeat(40), type: 'blob', mode: '100644' }]], ['2'.repeat(40), [{ name: 'hello.txt', hash: '4'.repeat(40), type: 'blob', mode: '100644' }]]]);
const blobs = new Map([['3'.repeat(40), 'hello\n'], ['4'.repeat(40), 'hello agent\n']]);
// Exported for tests that move a branch to a commit of their own.
export const commits = new Map([[base, { hash: base, treeHash: '1'.repeat(40), parents: [], message: 'Initial commit', author: { name: 'Alice' }, authoredAt: 1700000000 }],
  [feature, { hash: feature, treeHash: '2'.repeat(40), parents: [base], message: 'Greet the agent\n\nBody.', author: { name: 'Bob' }, authoredAt: 1700000100 }]]);

export async function accessFixture(t) {
  const f = await objectFixture(t);
  f.sql.exec(`UPDATE users SET email=login||'@example.invalid';
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(2,'tooling','','repo-${'e'.repeat(32)}',1,'k2','h2','ACTIVE','2026-10-14T00:00:00Z');
    INSERT INTO grants VALUES(2,1,'admin'),(2,2,'read');
    INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,12,'issue',2,'Fix the parser','It crashes on empty input.','OPEN','t','t'),
      (4,1,14,'pull',1,'Feature work','Body','OPEN','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,4,'main','feature','${base}','${feature}',0);
    INSERT INTO discussion_comments(discussion_id,author_id,body,created_at,updated_at) VALUES(1,1,'Please add a test.','t','t')`);
  const refs = new Map([['repo-' + 'b'.repeat(32), new Map([['refs/heads/main', base], ['refs/heads/feature', feature], ['refs/heads/agent/demo', feature]])], ['repo-' + 'e'.repeat(32), new Map([['refs/heads/main', base]])]]);
  const hooks = { opened: () => {} };
  f.env.ARTIFACTS = { async get(name) { hooks.opened(name); return {
    async info() { return { name, remote: `https://${f.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git` }; },
    async createToken() { return { plaintext: 'art_v1_token' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
    async readCommit(hash) { return commits.get(hash) || null; },
    async readTree(hash) { return trees.get(hash) || null; },
    async readBlob(hash) { return blobs.has(hash) ? new Blob([blobs.get(hash)]) : null; },
    async readBlobSize(hash) { return blobs.has(hash) ? new Blob([blobs.get(hash)]).size : null; },
    async log({ ref, limit = 20, offset = 0 }) {
      const out = []; let hash = /^[0-9a-f]{40}$/.test(ref) ? ref : refs.get(name).get('refs/heads/' + ref);
      while (hash && commits.has(hash)) { out.push(commits.get(hash)); hash = commits.get(hash).parents[0]; }
      return out.slice(offset, offset + limit);
    } }; } };
  const pushes = [];
  const providerFetch = async (input, init = {}) => {
    const url = new URL(input), name = /\/([^/]+)\.git\//.exec(url.pathname)[1], current = refs.get(name);
    if (url.pathname.endsWith('/info/refs')) {
      const service = url.searchParams.get('service');
      return new Response(Buffer.concat([packetLine(`# service=${service}\n`), Buffer.from('0000'), ...[...current].map(([ref, hash], i) => packetLine(`${hash} ${ref}${i ? '' : '\0report-status side-band-64k'}\n`)), Buffer.from('0000')]),
        { headers: { 'Content-Type': `application/x-${service}-advertisement` } });
    }
    if (url.pathname.endsWith('/git-receive-pack')) {
      const [old, next, ref] = Buffer.from(init.body).subarray(4).toString().split('\0')[0].split(' ');
      pushes.push({ name, old, next, ref }); current.set(ref, next);
      return new Response(Buffer.concat([packetLine('unpack ok\n'), packetLine(`ok ${ref}\n`), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    return new Response(Buffer.from('0008NAK\n'), { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
  };
  // Collaboration reads refs with the global fetch; only the in-memory provider answers, never the network.
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => /^https:\/\/c{32}\.artifacts\.cloudflare\.net\//.test(String(input)) ? providerFetch(input, init) : Promise.reject(Error('No network in tests'));
  t.after(() => { globalThis.fetch = original; });
  const dispatch = serialize(request => handle(request, f.env, providerFetch), admission);
  const json = async response => ({ status: response.status, headers: response.headers, ...(response.status === 202 || response.status === 405 ? {} : await response.json()) });
  // The Access-authenticated browser session that manages tokens.
  const session = (body, who = 'alice', headers = {}) => dispatch(new Request(origin + '/native/api-tokens', { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: origin, 'X-Golf-Native-Access-Email': who + '@example.invalid', ...headers } })).then(json);
  const create = async (body = {}, who = 'alice') => {
    const value = await session({ action: 'create', label: 'agent', permission: 'write', lifetimeHours: 24, ...body }, who);
    if (value.status !== 200) throw Error(`create refused: ${value.status} ${value.message}`);
    return value;
  };
  const rpc = (path, body, secret) => dispatch(new Request(origin + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...(secret ? { Authorization: 'Bearer ' + secret } : {}) } })).then(json);
  const mcp = (secret, method, params, id = 1, headers = {}) => dispatch(new Request(origin + '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }),
    headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: 'Bearer ' + secret } : {}), ...headers } })).then(json);
  const tool = async (secret, name, args) => (await mcp(secret, 'tools/call', { name, arguments: { ...repository, ...args } })).result;
  const git = (authorization, path, { method = 'GET', body, type, repo = 'project' } = {}) => dispatch(new Request(origin + `/git/alice/${repo}.git/${path}`, { method,
    headers: { ...(authorization ? { Authorization: authorization } : {}), ...(type ? { 'Content-Type': `application/x-${type}-request` } : {}) }, body }));
  const push = (authorization, ref, next = feature, old = zero, repo = 'project') => git(authorization, 'git-receive-pack', { method: 'POST', type: 'git-receive-pack', repo,
    body: Buffer.concat([packetLine(`${old} ${next} ${ref}\0report-status side-band-64k agent=git/2.43.0\n`), Buffer.from('0000PACK0000')]) });
  return { ...f, refs, pushes, hooks, providerFetch, dispatch, session, create, rpc, mcp, tool, git, push };
}
export const bearer = secret => 'Bearer ' + secret, basic = (secret, user = 'x') => 'Basic ' + btoa(user + ':' + secret);
