import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { digest, handle, serialize, concurrentRead, advanceEvidence, testGit, agentGit, servePreview, cleanupPreviews, runCI, withArtifact, confirmReadFromD1 } from './src/core.mjs';
import { settleRefWrites } from './src/ref-writes.mjs';
import { allocateApps } from './app-fixture.mjs';
import { previewBundle } from './src/delivery.mjs';
import { deny, bodyLimit } from './src/common.mjs';
import { reconcileIndexes } from './src/repository-indexes.mjs';
import { consumeEvidence, reconcileEvidence } from './src/evidence.mjs';
import { advertisedRefs, packetLine, receiveCommand, gitRequest } from './src/git.mjs';
import { treeObject } from './src/git-objects.mjs';

const ownerToken = 'golf_native_' + 'a'.repeat(43), readerToken = 'golf_native_' + 'b'.repeat(43);
const zero = '0'.repeat(40), commit = 'a'.repeat(40);
const push = (ref = 'refs/heads/main', old = zero, next = commit) => new Uint8Array(Buffer.concat([
  packetLine(`${old} ${next} ${ref}\0 report-status side-band-64k object-format=sha1 agent=git/2.54.0\n`), Buffer.from('0000PACK\0\0\0\x02'),
]));

// Independent decoder for the pack a native merge sends: one commit, plus the trees a three-way merge created.
// The fixture provider stores only what it can verify.
const treeTypes = { '40000': 'tree', '100644': 'blob', '100755': 'exec', '120000': 'symlink', '160000': 'gitlink' };
function unpackObjects(pack) {
  assert.equal(pack.subarray(0, 8).toString('hex'), '5041434b00000002');
  assert.deepEqual(pack.subarray(-20), createHash('sha1').update(pack.subarray(0, -20)).digest());
  const count = pack.readUInt32BE(8), objects = []; let offset = 12;
  for (let i = 0; i < count; i++) {
    let byte = pack[offset++], size = byte & 15, shift = 4; const type = { 1: 'commit', 2: 'tree' }[byte >> 4 & 7]; assert.ok(type);
    while (byte & 0x80) { byte = pack[offset++]; size |= (byte & 0x7f) << shift; shift += 7; }
    const { buffer: body, engine } = inflateSync(pack.subarray(offset, -20), { info: true }); assert.equal(body.length, size); offset += engine.bytesWritten;
    const hash = createHash('sha1').update(`${type} ${size}\0`).update(body).digest('hex');
    if (type === 'tree') {
      const entries = [];
      for (let at = 0; at < body.length;) { const space = body.indexOf(32, at), nul = body.indexOf(0, space); const mode = body.subarray(at, space).toString();
        entries.push({ name: body.subarray(space + 1, nul).toString(), hash: body.subarray(nul + 1, nul + 21).toString('hex'), type: treeTypes[mode], mode: mode.padStart(6, '0') }); at = nul + 21; }
      objects.push({ type, hash, entries }); continue;
    }
    const text = body.toString(), split = text.indexOf('\n\n'), headers = text.slice(0, split).split('\n');
    const author = /^author (.+) <([^<> ]+)> (\d+) \+0000$/.exec(headers.find(line => line.startsWith('author ')));
    assert.equal(headers.at(-1), headers.at(-2).replace('author ', 'committer '));
    objects.push({ type, commit: { hash, treeHash: headers[0].slice(5), parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
      message: text.slice(split + 2), author: { name: author[1], email: author[2] }, authoredAt: Number(author[3]) } });
  }
  assert.equal(offset, pack.length - 20);
  return objects;
}
function unpackCommit(pack, trees) {
  const objects = unpackObjects(pack), commits = objects.filter(object => object.type === 'commit');
  assert.equal(commits.length, 1);
  for (const object of objects) if (object.type === 'tree') trees?.set(object.hash, object.entries);
  return commits[0].commit;
}

async function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login,can_create) VALUES(1,'alice',1),(2,'bob',0)");
  for (const [token, id] of [[ownerToken, 1], [readerToken, 2]]) sql.prepare('INSERT INTO credentials VALUES(?,?,?,0)').run(await digest(token), id, Math.floor(Date.now() / 1000) + 300);
  const db = {
    withSession(mode) { assert.equal(mode, 'first-primary'); return this; },
    prepare(query) { let values = []; const statement = sql.prepare(query); return {
      bind(...args) { values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    }; },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const repos = new Map(), tokens = new Set(); let creates = 0, effects = 0, losePush = false, loseReply = false, refuseRef = false, busy = false, held, forks = 0, loseFork = false;
  const env = { DB: db, pushWaitMs: 100, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'test-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: 'https://golf.example.com',
    ARTIFACTS: {
      async create(name) {
        creates++; repos.set(name, { ref: null, refs: new Map() });
        return { name, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git`, token: 'initial' };
      },
      async get(name) { if (!repos.has(name)) throw Object.assign(Error('Missing'), { code: 'NOT_FOUND' }); return {
        async info() { if (!repos.has(name)) throw Object.assign(Error('Missing'), { code: 'NOT_FOUND' }); return { name, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/test-space/${name}.git`, source: repos.get(name).source, readOnly: false }; },
        async fork(target) { forks++; repos.set(target, { ...repos.get(name), refs: new Map(repos.get(name).refs), source: 'artifacts:test-space/' + name }); if (loseFork) { loseFork = false; throw Error('Lost fork acknowledgement'); } return { name: target }; },
        async listTokens() { return { tokens: [], total: 0 }; },
        async log(options = {}) { return repos.get(name).ref && !options.offset ? [{ hash: commit, treeHash: 'f'.repeat(40), parents: [], message: 'Native commit', author: { name: 'Alice' }, authoredAt: 1700000000 }] : []; },
        async readCommit(hash) { return repos.get(name).commits?.get(hash) || ([commit, 'b'.repeat(40), 'c'.repeat(40)].includes(hash) ? { hash, treeHash: 'f'.repeat(40), parents: hash === 'c'.repeat(40) ? ['b'.repeat(40)] : hash === 'b'.repeat(40) ? [commit] : [], message: 'Native commit', author: { name: 'Alice' }, authoredAt: 1700000000 } : null); },
        async readTree(hash) { return repos.get(name).trees?.get(hash) || (hash === 'f'.repeat(40) ? [
          { name: 'hello.txt', hash: '1'.repeat(40), type: 'blob', mode: '100644' },
          { name: 'link', hash: '2'.repeat(40), type: 'symlink', mode: '120000' },
          { name: 'module', hash: '3'.repeat(40), type: 'gitlink', mode: '160000' },
        ] : null); },
        async readBlob(hash) { return hash === '1'.repeat(40) ? new Blob(['hello native\n']) : hash === '2'.repeat(40) ? new Blob(['hello.txt']) : null; },
        async readFile({ ref, path }) { return ref === commit && path === 'hello.txt' ? new Blob(['hello native\n']) : null; },
        async createToken(scope, ttl) { assert.equal(ttl, 60); const plaintext = `art_v1_${scope === 'write' ? 'd' : 'e'}`.padEnd(71, scope === 'write' ? 'd' : 'e') + '?expires=2000000000'; tokens.add(plaintext); return { plaintext }; },
        async revokeToken(token) { tokens.delete(token); return true; },
        [Symbol.dispose]() {},
      }; },
    } };
  const providerFetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.ok(tokens.has(options.headers.Authorization.slice(7)));
    const name = new URL(url).pathname.split('/')[3].slice(0, -4);
    if (options.method === 'POST') {
      effects++;
      const command = receiveCommand(options.body), sent = Buffer.from(options.body), pack = sent.subarray(parseInt(sent.subarray(0, 4).toString(), 16) + 4);
      const apply = () => {
        if (pack.length > 8) { const object = unpackCommit(pack, repos.get(name).trees ||= new Map()); assert.equal(object.hash, command.next); assert.equal(repos.get(name).refs.get(command.ref), command.old); (repos.get(name).commits ||= new Map()).set(object.hash, object); }
        repos.get(name).ref = command.next; repos.get(name).refs.set(command.ref, command.next);
      };
      // A lost push may still land later (land); a lost reply follows an applied write.
      if (losePush) { held = apply; throw Error('unknown provider outcome containing sensitive metadata'); }
      // The provider keeps the unpacked object but refuses the ref update, as for a lost compare-and-swap.
      if (busy) { busy = false; return new Response(Buffer.concat([packetLine('ERR artifacts_git_receive_pack_busy\n'), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } }); }
      if (refuseRef) { (repos.get(name).commits ||= new Map()).set(command.next, unpackCommit(pack, repos.get(name).trees ||= new Map())); return new Response(Buffer.concat([packetLine('unpack ok\n'), packetLine(`ng ${command.ref} failed to update ref\n`), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } }); }
      apply();
      if (loseReply) { loseReply = false; throw Error('lost provider reply'); }
      return new Response(Buffer.concat([packetLine('unpack ok\n'), packetLine(`ok ${command.ref}\n`), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    }
    const refs = repos.get(name).refs;
    return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'),
      ...[...refs].map(([name, hash],index) => packetLine(`${hash} ${name}${index===0?'\0report-status':''}\n`)), Buffer.from('0000')]),
    { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  };
  sql.prepare('INSERT INTO workspaces(slug,artifact_namespace) VALUES(?,?)').run(env.WORKSPACE_SLUG, env.ARTIFACTS_NAMESPACE);
  const dispatch = serialize(event => event instanceof Request ? handle(event, env, providerFetch) : advanceEvidence(env, event.id, event.phase, env.workflow));
  const call = (method, body = {}, token = ownerToken, path) => dispatch(new Request(env.PUBLIC_ORIGIN + (path || '/rpc/golf.v1.RepositoryService/' + method), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body),
  }));
  const create = () => call('CreateRepository', { name: 'project', private: true, idempotencyKey: '12345678-1234-4234-8234-123456789012' });
  const sendPush = () => dispatch(new Request(env.PUBLIC_ORIGIN + '/git/alice/project.git/git-receive-pack', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/x-git-receive-pack-request' }, body: push(),
  }));
  return { sql, env, call, create, sendPush, tokens, providerFetch, dispatch, advance: (id, phase) => dispatch({ id, phase }), setRefs: refs => { for (const r of repos.values()) r.refs = new Map(refs); }, counts: () => ({ creates, effects, forks }), losePush: () => { losePush = true; }, loseReply: () => { loseReply = true; }, refuseRef: () => { refuseRef = true; }, busy: () => { busy = true; }, land: () => held(), loseFork: () => { loseFork = true; }, forks: () => forks };
}

test('native runner HTTP routes separate current admin sign-in from machine credentials', async t => {
  const f = await fixture(t);
  f.sql.prepare("UPDATE users SET email='alice@example.invalid' WHERE id=1").run();
  f.sql.prepare('INSERT INTO operations_admins(user_id) VALUES(1)').run();
  f.env.TEST_EXECUTION_ENABLED = 'true'; f.env.TEST_IMAGE_ID = 'sha256:'+'a'.repeat(64);
  const origin = f.env.PUBLIC_ORIGIN;
  const admin = body => f.dispatch(new Request(origin+'/native/runner-admin',{method:'POST',headers:{'X-Golf-Native-Access-Email':'alice@example.invalid','Content-Type':'application/json','Connect-Protocol-Version':'1'},body:JSON.stringify(body)}));
  const listed = await admin({action:'list'});
  assert.equal(listed.status,200); assert.deepEqual((await listed.json()).pools,[]);
  const poolId = crypto.randomUUID(), machineId = crypto.randomUUID();
  const saved = await admin({action:'savePool',id:poolId,expectedVersion:0,name:'http-pool',state:'ACTIVE',trustClass:'UNTRUSTED',maxParallel:1});
  assert.equal(saved.status,200); assert.equal((await saved.json()).pool.name,'http-pool');
  const enrolled = await admin({action:'enroll',id:machineId,poolId,poolVersion:1,name:'http-host',ttlHours:1,trustExecution:true});
  assert.equal(enrolled.status,200);
  const credential = (await enrolled.json()).credential;
  const validMachine = await f.dispatch(new Request(origin+'/native/runner-machine/claim',{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:JSON.stringify({claimId:crypto.randomUUID()})}));
  assert.equal(validMachine.status,200); assert.deepEqual(await validMachine.json(),{assignment:null});
  const bearer = await f.dispatch(new Request(origin+'/native/runner-admin',{method:'POST',headers:{Authorization:'Bearer '+ownerToken,'Content-Type':'application/json','Connect-Protocol-Version':'1'},body:JSON.stringify({action:'list'})}));
  assert.equal(bearer.status,403);
  const machine = await f.dispatch(new Request(origin+'/native/runner-machine/claim',{method:'POST',headers:{Authorization:'Bearer golf_runner_11111111-1111-4111-8111-111111111111_'+ '0'.repeat(64),'Content-Type':'application/json'},body:JSON.stringify({claimId:crypto.randomUUID()})}));
  assert.equal(machine.status,403);
});

test('a push probe is acknowledged and an oversized push is refused with a clear 413', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  const post = body => f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/git-receive-pack', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/x-git-receive-pack-request' }, body }));
  const probe = await post(Buffer.from('0000'));
  assert.equal(probe.status, 200); assert.equal(probe.headers.get('Content-Type'), 'application/x-git-receive-pack-result'); assert.equal((await probe.arrayBuffer()).byteLength, 0);
  assert.equal(f.counts().effects, 1);
  const large = await post(new Uint8Array(8 * 1024 * 1024 + 1));
  assert.equal(large.status, 413); assert.match((await large.json()).message, /limited to 8 MiB/);
});

test('default metadata overlaps independent provider reads and withholds mismatched identity', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  const get = f.env.ARTIFACTS.get; let started = false, finished = false, disposed = false, mismatch = false;
  f.env.ARTIFACTS.get = async name => {
    const repo = await get(name), info = repo.info;
    return { ...repo,
      async info() { await new Promise(resolve => setImmediate(resolve)); assert.equal(started, true); return { ...await info(), ...(mismatch ? { name: 'wrong' } : {}) }; },
      async log() { started = true; await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(disposed, false); finished = true; return [{ hash: commit }]; },
      [Symbol.dispose]() { assert.equal(finished, true); disposed = true; },
    };
  };
  let response = await f.call('GetRepository', { repository: { owner: 'alice', name: 'project' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).sourceSelection.commitId, commit);
  assert.match(response.headers.get('Server-Timing'), /artifact_log/);
  mismatch = true; started = finished = disposed = false;
  response = await f.call('GetRepository', { repository: { owner: 'alice', name: 'project' } });
  assert.equal(response.status, 503); assert.equal(disposed, true);
});

test('D1 identity, private repository creation/replay, brokered push and immutable content', async t => {
  const f = await fixture(t);
  const first = await f.create(); assert.equal(first.status, 200);
  const created = await first.json(); assert.equal(created.repository.cloneUrl, 'https://golf.example.com/git/alice/project.git');
  assert.equal((await f.create()).status, 200); assert.equal(f.counts().creates, 1);
  assert.equal((await f.call('CreateRepository', { name: 'other', private: true, idempotencyKey: '12345678-1234-4234-8234-123456789012' })).status, 409);
  assert.equal((await f.sendPush()).status, 200); assert.equal(f.counts().effects, 1); assert.equal(f.tokens.size, 0);
  const content = await f.call('GetContents', { repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ref: commit, path: 'hello.txt' });
  assert.equal(content.status, 200); assert.equal((await content.json()).file.content, 'hello native\n');
  assert.equal(f.sql.prepare('SELECT state FROM git_operations').get().state, 'APPLIED');
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
});

test('repository inventories overlap four provider reads, preserve order and never include a foreign grant', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 7; i++) assert.equal((await f.call('CreateRepository', { name: 'project-' + i, private: true, idempotencyKey: crypto.randomUUID() })).status, 200);
  f.sql.prepare('INSERT INTO grants VALUES(1,2,?)').run('read');
  const get = f.env.ARTIFACTS.get; let active = 0, maximum = 0;
  f.env.ARTIFACTS.get = async name => {
    const repo = await get(name), log = repo.log;
    repo.log = async options => { active++; maximum = Math.max(maximum, active); try { await new Promise(resolve => setTimeout(resolve, 5)); return await log(options); } finally { active--; } };
    return repo;
  };
  const all = await (await f.call('ListRepositories', {})).json();
  assert.equal(maximum, 4); assert.deepEqual(all.repositories.map(row => row.name), Array.from({length:7}, (_, i) => 'project-' + i));
  const reader = await (await f.call('ListRepositories', {}, readerToken)).json();
  assert.deepEqual(reader.repositories.map(row => row.id), ['1']);
  f.env.ARTIFACTS.get = () => { throw Error('Inventory must not open Git storage'); };
  const metadata = await (await f.call('ListRepositories', { metadataOnly: true }, readerToken)).json();
  assert.deepEqual(metadata.repositories.map(row => row.id), ['1']);
  assert.equal(Object.hasOwn(metadata.repositories[0], 'empty'), false);
});

test('imported default branches drive metadata, source resolution, history and settings revisions', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  const key = { owner: 'alice', name: 'project' };
  const callSettings = body => f.call('GetRepositorySettings', { repository: key, ...body }, ownerToken, '/rpc/golf.v1.RepositorySettingsService/GetRepositorySettings');
  const original = (await (await callSettings({})).json()).settings;
  const get = f.env.ARTIFACTS.get;
  let selected;
  f.env.ARTIFACTS.get = async name => { const repo = await get(name), log = repo.log; repo.log = options => { selected = options.ref; return log(options); }; return repo; };
  for (const branch of ['master', 'dev']) {
    f.sql.prepare('UPDATE repositories SET default_branch=? WHERE id=1').run(branch);
    f.setRefs([['refs/heads/' + branch, commit]]);
    const metadata = await (await f.call('GetRepository', { repository: key })).json();
    assert.deepEqual(metadata.sourceSelection, { kind: 'REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH', name: branch, commitId: commit });
    assert.equal(metadata.repository.defaultBranch, branch); assert.equal(metadata.repository.empty, false); assert.equal(selected, branch);
    const resolution = await (await f.call('ResolveRepositorySource', { repository: key, repositoryId: '1' })).json();
    assert.equal(resolution.selection.name, branch); assert.equal(resolution.selection.commitId, commit);
    const history = await (await f.call('ListCommits', { repository: key })).json();
    assert.equal(history.commits[0].sha, commit); assert.equal(selected, commit);
    const settings = (await (await callSettings({})).json()).settings;
    assert.equal(settings.defaultBranch, branch); assert.notEqual(settings.revision, original.revision);
    assert.equal((await f.call('UpdateRepositorySettings', { repository: key, repositoryId: '1', ownerId: settings.ownerId, expectedRevision: original.revision, description: 'stale' }, ownerToken, '/rpc/golf.v1.RepositorySettingsService/UpdateRepositorySettings')).status, 412);
  }
});

test('shallow source snapshots remain browsable without inventing entry history', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  const get = f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get = async name => { const repo = await get(name), read = repo.readCommit; repo.readCommit = async hash => hash === commit ? { ...await read(hash), parents: ['d'.repeat(40)] } : null; return repo; };
  const response = await f.call('GetContents', { repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ref: commit, includeLatestChanges: true });
  assert.equal(response.status, 200);
  const source = await response.json(); assert.equal(source.entries.length, 3);
  assert.ok(source.entries.every(entry => !entry.latestChange));
  assert.equal(source.commitId, commit);
});

test('large directories page immutable entries without reading off-page blobs and retain fresh grants', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  const get = f.env.ARTIFACTS.get; let blobs = 0;
  f.env.ARTIFACTS.get = async name => { const repo = await get(name), blob = repo.readBlob;
    repo.readTree = async () => Array.from({ length: 132 }, (_, i) => ({ name: `file-${String(i).padStart(3, '0')}`, type: 'blob', hash: 'e'.repeat(40), mode: '100644' })).reverse();
    repo.readBlob = async () => { blobs++; return new Blob(['hello']); }; return repo;
  };
  const body = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ref: commit, page: { page: 1, limit: 100 } };
  const firstResponse = await f.call('GetContents', body), first = await firstResponse.json();
  assert.equal(firstResponse.status, 200); assert.equal(first.entries.length, 100); assert.equal(first.entries[0].name, 'file-000'); assert.equal(first.totalEntries, 132); assert.equal(first.page.nextPage, 2); assert.equal(blobs, 100);
  const second = await (await f.call('GetContents', { ...body, page: { page: 2, limit: 100 } })).json();
  assert.equal(second.entries.length, 32); assert.equal(second.entries[0].name, 'file-100'); assert.equal(second.page.nextPage, 0); assert.equal(blobs, 132);
  assert.match(firstResponse.headers.get('Server-Timing'), /d1;dur=.*artifacts;dur=.*native;dur=/);
  assert.equal((await f.call('GetContents', { ...body, page: { page: 1, limit: 101 } })).status, 400);
  f.sql.prepare('DELETE FROM grants WHERE user_id=1').run();
  assert.equal((await f.call('GetContents', body)).status, 404); assert.equal(blobs, 132);
});

test('admission bounds pending work and preserves the revocation fence under overload', async () => {
  let finish; const barrier = new Promise(resolve => { finish = resolve; });
  const request = () => new Request('https://golf.example.com/rpc/golf.v1.SessionService/GetSession', { method: 'POST' });
  const run = serialize(async () => { await barrier; return new Response('ok'); }, concurrentRead);
  const admitted = Array.from({ length: 8 + 512 }, () => run(request()));
  const refused = await run(request()); assert.equal(refused.status, 429); assert.equal(refused.headers.get('Retry-After'), '1');
  finish(); assert.ok((await Promise.all(admitted)).every(response => response.status === 200));
});

test('independent immutable reads fail closed if authority is revoked before completion', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  const request = () => new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.RepositoryService/GetContents', { method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ref: commit, path: 'hello.txt' }) });
  let validations = 0;
  const response = await handle(request(), { ...f.env, confirmRead: async authority => { validations++; assert.equal(authority.repositoryId, '1'); assert.equal(authority.role, 'admin'); f.sql.prepare('DELETE FROM grants WHERE user_id=1').run(); deny(); } }, f.providerFetch);
  assert.equal(response.status, 404); assert.equal(validations, 1); assert.ok(!(await response.text()).includes('hello native'));
  const unavailable = await handle(request(), { ...f.env, confirmRead: async () => { throw Error('network lost'); } }, f.providerFetch);
  assert.equal(unavailable.status, 404);
  f.sql.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  assert.equal((await handle(request(), { ...f.env, confirmRead: async () => { throw Error('network lost'); } }, f.providerFetch)).status, 503);
});

test('a clone outside the workspace queue is refused when its grant is revoked while the provider answers', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  const clone = () => handle(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/info/refs?service=git-upload-pack', { headers: { Authorization: 'Bearer ' + ownerToken } }), f.env,
    async (request, ...rest) => { if (new URL(request.url ?? request).pathname.endsWith('/info/refs')) f.sql.prepare('DELETE FROM grants WHERE user_id=1').run(); return f.providerFetch(request, ...rest); });
  const response = await clone();
  assert.equal(response.status, 404); assert.ok(!(await response.text()).includes('git-upload-pack'));
  f.sql.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  assert.equal((await handle(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/info/refs?service=git-upload-pack', { headers: { Authorization: 'Bearer ' + ownerToken } }), f.env, f.providerFetch)).status, 200);
});

test('reads confirmed from D1 (RepositoryReads, the stateless Worker): the credential, grant and role read again after the read', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  f.sql.exec("UPDATE users SET email=login || '@example.invalid'");
  const request = headers => new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.RepositoryService/GetContents', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ref: commit, path: 'hello.txt' }) });
  const read = async (headers, during) => {
    const req = request(headers);
    return handle(req, { ...f.env, confirmRead: async (authority, clock) => { during?.(); return confirmReadFromD1(req, f.env)(authority, clock); } }, f.providerFetch);
  };
  // A native credential and an Access identity (the browser) both pass while nothing changed.
  for (const headers of [{ Authorization: 'Bearer ' + ownerToken }, { 'X-Golf-Native-Access-Email': 'alice@example.invalid' }]) assert.equal((await read(headers)).status, 200);
  // A lowered role, a deleted grant or a revoked credential between the read and the response refuses it.
  const lowered = await read({ Authorization: 'Bearer ' + ownerToken }, () => f.sql.prepare("UPDATE grants SET role='read' WHERE user_id=1").run());
  assert.equal(lowered.status, 404); f.sql.prepare("UPDATE grants SET role='admin' WHERE user_id=1").run();
  assert.equal((await read({ 'X-Golf-Native-Access-Email': 'alice@example.invalid' }, () => f.sql.prepare('DELETE FROM grants WHERE user_id=1').run())).status, 404);
  f.sql.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  assert.equal((await read({ Authorization: 'Bearer ' + ownerToken }, () => f.sql.prepare('UPDATE credentials SET revoked=1 WHERE user_id=1').run())).status, 401);
  // An anonymous read of a public repository is confirmed as public; a repository made private meanwhile refuses it.
  f.env.PUBLIC_REPOSITORIES = 'true'; f.sql.exec('INSERT INTO repository_visibility(repository_id,is_public,version) VALUES(1,1,1)');
  assert.equal((await read({})).status, 200);
  assert.equal((await read({}, () => f.sql.prepare('UPDATE repository_visibility SET is_public=0,version=2 WHERE repository_id=1').run())).status, 404);
  f.sql.prepare('UPDATE repository_visibility SET is_public=1,version=3 WHERE repository_id=1').run();
  for (const method of ['GetRepository', 'GetRepositoryOverview']) {
    const req = new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.RepositoryService/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ repository: { owner: 'alice', name: 'project' } }) });
    const response = await handle(req, { ...f.env, confirmRead: confirmReadFromD1(req, f.env) }, f.providerFetch);
    assert.equal(response.status, 200, method + ' ' + await response.clone().text());
  }
});

test('membership never implies repository access; grants and revocation are current', async t => {
  const f = await fixture(t); await f.create();
  const key = { owner: 'alice', name: 'project' };
  assert.equal((await f.call('GetRepository', { repository: key }, readerToken)).status, 404);
  assert.deepEqual((await (await f.call('ListRepositories', {}, readerToken)).json()).repositories, []);
  const grant = { repository: key, repositoryId: '1', userId: '2', role: 'read' };
  assert.equal((await f.call('', grant, ownerToken, '/native/repository-grant')).status, 200);
  assert.equal((await f.call('GetRepository', { repository: key }, readerToken)).status, 200);
  assert.equal((await f.call('', { ...grant, role: 'write' }, readerToken, '/native/repository-grant')).status, 404);
  assert.equal((await f.call('', { ...grant, role: 'none' }, ownerToken, '/native/repository-grant')).status, 200);
  assert.equal((await f.call('GetRepository', { repository: key }, readerToken)).status, 404);
  f.sql.prepare('UPDATE credentials SET revoked=1 WHERE user_id=1').run();
  assert.equal((await f.call('GetRepository', { repository: key })).status, 401);
});

const refusal = async response => /ng \S+ ([^\n]*)/.exec(new TextDecoder().decode(await response.arrayBuffer()))?.[1] || '';
test('ambiguous Git effects are resent only as the same compare-and-swap, a bounded number of times, then durably fenced', async t => {
  const f = await fixture(t); await f.create(); f.losePush();
  // While the ref still holds the old commit, the identical update is resent (at most one copy can land); then the outcome is unknown.
  // The client receives Git's own refusal; only this branch waits for maintenance.
  const first = await f.sendPush(); assert.equal(first.status, 200);
  const reason = await refusal(first); assert.match(reason, /outcome of this update is unknown/); assert.ok(!reason.includes('sensitive'));
  assert.match(await refusal(await f.sendPush()), /another push to this branch is in progress/); assert.equal(f.counts().effects, 5);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_ref_unknown').get().n, 1);
  assert.equal(f.sql.prepare('SELECT state FROM git_operations').get().state, 'DISPATCHED');
  assert.equal(f.tokens.size, 0);
});

test('a write that finishes between a push\'s reservation and its blocker check is a race: the push tries again and lands', async t => {
  const f = await fixture(t); await f.create();
  f.env.pushWaitMs = 5000;
  // A merge holds the repository when the push reserves, and has finished by the time the push asks what blocks it.
  f.sql.exec("UPDATE repositories SET write_pending='merge-op'");
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = sql => { if (sql.startsWith('SELECT write_pending,EXISTS')) f.sql.exec('UPDATE repositories SET write_pending=NULL'); return prepare(sql); };
  const pushed = await handle(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/git-receive-pack', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/x-git-receive-pack-request' }, body: push('refs/heads/raced', zero, commit) }), f.env, f.providerFetch);
  assert.equal(pushed.status, 200); assert.doesNotMatch(await pushed.text(), /remote rejected|\bng\b/);
});

test('a push waits out a merge holding the repository and then lands; a longer hold is refused in Git\'s report', async t => {
  const f = await fixture(t); await f.create();
  const send = (ref, old = zero, next = commit) => handle(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/git-receive-pack', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/x-git-receive-pack-request' }, body: push(ref, old, next) }), f.env, f.providerFetch);
  f.env.pushWaitMs = 5000;
  f.sql.exec("UPDATE repositories SET write_pending='merge-op'");
  setTimeout(() => f.sql.exec('UPDATE repositories SET write_pending=NULL'), 400);
  const started = Date.now(), pushed = await send('refs/heads/waited');
  assert.equal(pushed.status, 200); assert.doesNotMatch(await pushed.text(), /remote rejected|\bng\b/); assert.ok(Date.now() - started >= 300);
  f.env.pushWaitMs = 100;
  f.sql.exec("UPDATE repositories SET write_pending='merge-op'");
  assert.match(await (await send('refs/heads/refused')).text(), /finishing a merge/);
  f.sql.exec('UPDATE repositories SET write_pending=NULL');
});

test('the ref fence: a push to another branch proceeds, one to the same branch conflicts, a held repository refuses both', async t => {
  const f = await fixture(t); await f.create();
  let entered, release; const inFlight = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const providerFetch = async (url, options) => {
    // The fixture issues one write token string, which the overlapping push revokes; the provider issues distinct tokens.
    if (options.method === 'POST' && receiveCommand(options.body).ref === 'refs/heads/main') { entered(); await gate; f.tokens.add(options.headers.Authorization.slice(7)); }
    return f.providerFetch(url, options);
  };
  const send = (ref, old = zero, next = commit) => handle(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/git-receive-pack', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/x-git-receive-pack-request' }, body: push(ref, old, next) }), f.env, providerFetch);
  const main = send('refs/heads/main'); await inFlight;
  // In flight, the push holds its ref only.
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
  assert.deepEqual({ ...f.sql.prepare('SELECT ref,outcome FROM git_ref_writes').get() }, { ref: 'refs/heads/main', outcome: null });
  assert.match(await refusal(await send('refs/heads/main')), /another push to this branch is in progress/);
  assert.equal((await send('refs/heads/topic')).status, 200);
  // A merge journals through its own statement; onto a fenced ref it is not journaled at all.
  const journal = ref => f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES(?,1,1,?,?,?,'DISPATCHED','t')").run(crypto.randomUUID(), ref, zero, commit).changes;
  assert.equal(journal('refs/heads/main'), 0);
  release(); assert.equal((await main).status, 200);
  assert.deepEqual(f.sql.prepare('SELECT ref,state FROM git_operations ORDER BY ref').all().map(row => ({ ...row })), [{ ref: 'refs/heads/main', state: 'APPLIED' }, { ref: 'refs/heads/topic', state: 'APPLIED' }]);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_ref_writes').get().n, 0);
  assert.equal(journal('refs/heads/main'), 1);
  f.sql.exec("DELETE FROM git_operations WHERE state='DISPATCHED'; UPDATE repositories SET write_pending='unresolved'");
  assert.match(await refusal(await send('refs/heads/other')), /finishing a merge/); assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_operations').get().n, 2);
});

test('a push the provider refuses (a lost race) returns Git\'s own report and releases the ref and the repository', async t => {
  const f = await fixture(t); await f.create();
  const line = text => { const bytes = new TextEncoder().encode(text); return new Uint8Array([...new TextEncoder().encode((bytes.length + 4).toString(16).padStart(4, '0')), ...bytes]); };
  const band = inner => line('\x01' + new TextDecoder().decode(inner));
  const report = new Uint8Array([...band(new Uint8Array([...line('unpack ok\n'), ...line('ng refs/heads/main fetch first\n'), ...new TextEncoder().encode('0000')])), ...new TextEncoder().encode('0000')]);
  let refuse = true;
  const providerFetch = async (url, options) => refuse && options.method === 'POST' && options.body && receiveCommand(options.body).ref === 'refs/heads/main'
    ? new Response(report, { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } }) : f.providerFetch(url, options);
  const send = () => handle(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/git-receive-pack', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/x-git-receive-pack-request' }, body: push('refs/heads/main') }), f.env, providerFetch);
  const refused = await send();
  assert.equal(refused.status, 200); assert.deepEqual(new Uint8Array(await refused.arrayBuffer()), report);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
  assert.deepEqual({ ...f.sql.prepare('SELECT outcome FROM git_ref_writes').get() }, { outcome: 'NOT_APPLIED' });
  // The retry is admitted at once and lands.
  refuse = false; assert.equal((await send()).status, 200);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM git_operations WHERE state='APPLIED'").get().n, 1);
  // An unreadable or accepting report is never taken as a refusal.
  const { refusedRef } = await import('./src/git.mjs');
  assert.equal(refusedRef(new Uint8Array([...line('unpack ok\n'), ...line('ng refs/heads/main non-fast-forward\n'), ...new TextEncoder().encode('0000')]), 'refs/heads/main'), true);
  assert.equal(refusedRef(new Uint8Array([...line('unpack ok\n'), ...line('ok refs/heads/main\n')]), 'refs/heads/main'), false);
  assert.equal(refusedRef(new Uint8Array([...line('unpack ok\n'), ...line('ng refs/heads/other fetch first\n')]), 'refs/heads/main'), false);
  assert.equal(refusedRef(new TextEncoder().encode('zzzz'), 'refs/heads/main'), false);
  // Git's error packet as the session's first line is a refused session; anywhere else, or an ordinary report, is not.
  const { sessionRefused } = await import('./src/git.mjs');
  assert.equal(sessionRefused(new Uint8Array([...line('ERR artifacts_git_receive_pack_busy\n'), ...new TextEncoder().encode('0000')])), true);
  assert.equal(sessionRefused(new Uint8Array([...line('unpack ok\n'), ...line('ERR late\n')])), false);
  assert.equal(sessionRefused(new Uint8Array([...line('unpack ok\n'), ...line('ok refs/heads/main\n')])), false);
  assert.equal(sessionRefused(new TextEncoder().encode('zzzz')), false);
});

test('a push the provider fails while the ref is unchanged is resent and lands; the client gets an ordinary success', async t => {
  const f = await fixture(t); await f.create();
  let failures = 1, posts = 0;
  const providerFetch = async (url, options) => {
    if (options.method === 'POST' && options.body && new URL(url).pathname.endsWith('/git-receive-pack')) { posts++; if (failures-- > 0) return new Response('busy', { status: 503 }); }
    return f.providerFetch(url, options);
  };
  const response = await handle(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/git-receive-pack', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/x-git-receive-pack-request' }, body: push('refs/heads/main') }), f.env, providerFetch);
  assert.equal(response.status, 200); assert.equal(posts, 2);
  assert.equal(f.sql.prepare('SELECT state FROM git_operations').get().state, 'APPLIED');
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_ref_writes').get().n, 0);
  // When an earlier copy landed and the provider's last reply refuses the resend, the client still receives its own success.
  const { acceptedReport, receiveStatus } = await import('./src/git.mjs');
  assert.equal(receiveStatus(acceptedReport({ ref: 'refs/heads/main', sideband: false }), 'refs/heads/main'), '');
  const banded = acceptedReport({ ref: 'refs/heads/main', sideband: true });
  assert.equal(banded[4], 1); assert.match(new TextDecoder().decode(banded), /ok refs\/heads\/main/);
});

test('maintenance settles unknown push outcomes by reading the ref back, once, with an audit row', async t => {
  const f = await fixture(t); await f.create();
  const sent = [], env = { ...f.env, providerFetch: f.providerFetch, PIPELINES_ENABLED: 'true', PIPELINE_BUCKET: {}, PIPELINE_QUEUE: { async send(message) { sent.push(message); } } };
  const settle = () => settleRefWrites(env, withArtifact), age = () => f.sql.exec("UPDATE git_operations SET created_at='2026-01-01T00:00:00.000Z' WHERE state='DISPATCHED'");
  const pending = () => f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending;
  // The provider loses the reply; the push lands later.
  f.losePush(); assert.match(await refusal(await f.sendPush()), /outcome of this update is unknown/);
  const first = f.sql.prepare('SELECT * FROM git_operations').get(), unknown = () => f.sql.prepare('SELECT COUNT(*) n FROM git_ref_unknown').get().n;
  assert.equal(first.state, 'DISPATCHED'); assert.equal(pending(), null); assert.equal(unknown(), 1);
  assert.deepEqual(await settle(), { processed: 0 });
  age(); f.land();
  assert.deepEqual(await settle(), { processed: 1 });
  assert.equal(f.sql.prepare('SELECT state FROM git_operations WHERE id=?').get(first.id).state, 'APPLIED'); assert.equal(pending(), null); assert.equal(unknown(), 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_ref_writes').get().n, 0);
  assert.deepEqual(f.sql.prepare('SELECT id,kind FROM pipeline_intake').all().map(row => ({ ...row })), [{ id: 'push:' + first.id, kind: 'push' }]); assert.deepEqual(sent, [{ intake: 'push:' + first.id }]);
  assert.deepEqual(await settle(), { processed: 0 });
  // The next lost push never lands: NOT_APPLIED, and the ref and the repository are released.
  const lost = await f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/git-receive-pack', { method: 'POST',
    headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/x-git-receive-pack-request' }, body: push('refs/heads/main', commit, 'b'.repeat(40)) }));
  assert.match(await refusal(lost), /outcome of this update is unknown/);
  const second = f.sql.prepare("SELECT * FROM git_operations WHERE state='DISPATCHED'").get();
  age(); assert.deepEqual(await settle(), { processed: 1 });
  assert.equal(f.sql.prepare('SELECT state FROM git_operations WHERE id=?').get(second.id).state, 'DISPATCHED');
  assert.equal(f.sql.prepare('SELECT outcome FROM git_ref_writes WHERE operation_id=?').get(second.id).outcome, 'NOT_APPLIED'); assert.equal(pending(), null);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM pipeline_intake').get().n, 1);
  const audit = f.sql.prepare("SELECT scope,scope_id,subject,after FROM installation_audit WHERE action='git_write.settle' ORDER BY id").all();
  assert.deepEqual(audit.map(row => [row.scope, row.scope_id, row.subject, JSON.parse(row.after).outcome]), [['repository', '1', 'refs/heads/main', 'APPLIED'], ['repository', '1', 'refs/heads/main', 'NOT_APPLIED']]);
  const { describe } = await import('./src/audit.mjs');
  assert.equal(describe({ action: 'git_write.settle', subject: 'refs/heads/main', after: JSON.parse(audit[1].after), outcome: 'success' }), 'settled the unconfirmed push to refs/heads/main as not applied');
  assert.deepEqual(await settle(), { processed: 0 });
  // A legacy unknown write holds only write_pending; a merge's own write is left to the merge.
  const legacy = crypto.randomUUID(), merge = crypto.randomUUID();
  f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES(?,1,1,'refs/heads/main',?,?,'DISPATCHED','2026-01-01T00:00:00.000Z')").run(legacy, commit, 'c'.repeat(40));
  f.sql.prepare('UPDATE repositories SET write_pending=?').run(legacy);
  assert.deepEqual(await settle(), { processed: 1 }); assert.equal(pending(), null);
  f.sql.exec(`INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'pull',1,'One','','OPEN','t','t');
    INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,1,'main','one','a','b',0)`);
  f.sql.prepare("INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,created_at) VALUES(?,1,1,'refs/heads/main',?,?,'DISPATCHED','2026-01-01T00:00:00.000Z')").run(merge, commit, 'c'.repeat(40));
  f.sql.prepare("INSERT INTO pull_merge_operations(actor_id,operation_id,repository_id,pull_request_id,input_hash,original,phase,git_operation_id,created_at,updated_at) VALUES(1,'m',1,1,'h','{}','DISPATCH_UNKNOWN',?,'t','t')").run(merge);
  f.sql.prepare('UPDATE repositories SET write_pending=?').run(merge);
  assert.deepEqual(await settle(), { processed: 0 }); assert.equal(pending(), merge);
});

test('Git grammar rejects extra commands, traversal and unsupported effects before dispatch', () => {
  assert.equal(receiveCommand(push()).ref, 'refs/heads/main');
  for (const ref of ['refs/heads/../escape', 'refs/heads/a.lock', 'refs/replace/abc', 'refs/heads/a//b']) assert.throws(() => receiveCommand(push(ref)));
  assert.throws(() => receiveCommand(Buffer.concat([packetLine(`${zero} ${commit} refs/heads/main\0report-status\n`), push()])));
  assert.throws(() => advertisedRefs(Buffer.from('zzzz')));
});

test('workspace serialization holds revocation behind an already admitted effect', async () => {
  const events = []; let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const run = serialize(async name => { events.push(name); if (name === 'push') await barrier; events.push(name + '-done'); });
  const write = run('push'), revoke = run('revoke');
  await Promise.resolve(); assert.deepEqual(events, ['push']); release();
  await Promise.all([write, revoke]); assert.deepEqual(events, ['push', 'push-done', 'revoke', 'revoke-done']);
});

test('immutable trees preserve symlinks and submodules without traversal', async t => {
  const f = await fixture(t); await f.create();
  const selection = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ref: commit };
  const tree = await (await f.call('GetContents', selection)).json();
  assert.equal(tree.kind, 'SOURCE_ENTRY_TYPE_DIRECTORY');
  assert.deepEqual(tree.entries.map(e => e.type), ['SOURCE_ENTRY_TYPE_FILE', 'SOURCE_ENTRY_TYPE_SYMLINK', 'SOURCE_ENTRY_TYPE_SUBMODULE']);
  const link = await (await f.call('GetContents', { ...selection, path: 'link' })).json();
  assert.equal(link.file.content, 'hello.txt');
  assert.equal(link.kind, 'SOURCE_ENTRY_TYPE_SYMLINK');
  assert.equal((await f.call('GetContents', { ...selection, path: 'link/hello.txt' })).status, 404);
  assert.equal((await f.call('GetContents', { ...selection, path: '../hello.txt' })).status, 400);
  const module = await (await f.call('GetContents', { ...selection, path: 'module' })).json();
  assert.equal(module.file.previewReason, 'Submodule reference.');
  await f.sendPush();
  const resolved = await (await f.call('ResolveRepositorySource', { repository: selection.repository })).json();
  assert.equal(resolved.selection.commitId, commit);
});

test('public origin, current credentials and unsupported capabilities fail closed', async t => {
  const f = await fixture(t);
  const request = origin => new Request(origin + '/rpc/golf.v1.SessionService/GetSession', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}',
  });
  assert.equal((await handle(request('https://alternate.example.com'), f.env)).status, 403);
  const foreign = request(f.env.PUBLIC_ORIGIN); foreign.headers.set('Origin', 'https://other.example.com');
  assert.equal((await handle(foreign, f.env)).status, 403);
  assert.equal((await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/Unknown')).status, 501);
  f.sql.prepare('UPDATE credentials SET expires_at=1').run();
  assert.equal((await handle(request(f.env.PUBLIC_ORIGIN), f.env)).status, 401);
});

test('an unresolved push does not prevent repository access revocation', async t => {
  const f = await fixture(t); await f.create();
  const grant = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1', userId: '2', role: 'read' };
  assert.equal((await f.call('', grant, ownerToken, '/native/repository-grant')).status, 200);
  f.losePush(); assert.match(await refusal(await f.sendPush()), /outcome of this update is unknown/);
  assert.equal((await f.call('', { ...grant, role: 'none' }, ownerToken, '/native/repository-grant')).status, 200);
  assert.equal((await f.call('GetRepository', { repository: grant.repository }, readerToken)).status, 404);
  assert.match(await refusal(await f.sendPush()), /another push to this branch is in progress/);
});

test('provider credentials stay opaque, reject header injection and are always revoked', async () => {
  const env = { ACCOUNT_ID: 'a'.repeat(32), ARTIFACTS_NAMESPACE: 'native-proof' };
  for (const token of ['provider-format-may-change', 'bad\r\nInjected: true']) {
    let revoked = false, fetched = false;
    const repo = {
      async createToken(scope, ttl) { assert.equal(scope, 'read'); assert.equal(ttl, 60); return { plaintext: token }; },
      async revokeToken(value) { assert.equal(value, token); revoked = true; return true; },
    };
    const fetcher = async (url, options) => {
      fetched = true; assert.equal(options.headers.Authorization, 'Bearer ' + token);
      return new Response('0000', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
    };
    const call = gitRequest(env, repo, 'repo-' + 'b'.repeat(32), 'info/refs?service=git-upload-pack', 'git-upload-pack', null, fetcher);
    if (token.startsWith('bad')) { await assert.rejects(call); assert.equal(fetched, false); }
    else { await call; assert.equal(fetched, true); }
    assert.equal(revoked, true);
  }
  await assert.rejects(gitRequest(env, { createToken() { throw Error('Must not mint'); } }, 'repo-' + 'b'.repeat(32),
    'info/refs?service=git-upload-pack', 'git-upload-pack', null, () => { throw Error('Must not dispatch'); }, 'version=3'), /Unsupported Git protocol/);
});

async function value(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const key = { owner: 'alice', name: 'project' };
const nonce = () => crypto.randomUUID();

test('native issues/comments have shared numbers, exact revision updates and atomic replay', async t => {
  const f = await fixture(t); await f.create();
  const input = { repository: key, repositoryId: '1', title: 'Issue', body: 'Details', idempotencyKey: nonce() };
  assert.equal((await f.call('CreateIssue', { ...input, body: false, idempotencyKey: nonce() })).status, 400);
  const created = await value(await f.call('CreateIssue', input));
  assert.equal(created.issue.number, 1);
  assert.equal((await value(await f.call('CreateIssue', { ...input }))).issue.id, created.issue.id);
  assert.equal((await f.call('CreateIssue', { ...input, title: 'Different' })).status, 409);
  const edit = { repository: key, repositoryId: '1', issueId: created.issue.id, number: 1,
    expectedRevision: created.issue.revision, title: 'Edited', idempotencyKey: nonce() };
  const changed = await value(await f.call('UpdateIssue', edit));
  assert.equal(changed.issue.title, 'Edited');
  assert.equal((await f.call('UpdateIssue', { ...edit, idempotencyKey: nonce(), title: 'Stale' })).status, 412);
  assert.equal((await value(await f.call('UpdateIssue', edit))).issue.title, 'Edited');
  const comment = { repository: key, repositoryId: '1', issueId: created.issue.id, number: 1, body: 'Reply', idempotencyKey: nonce() };
  const posted = await value(await f.call('CreateIssueComment', comment));
  await value(await f.call('CreateIssueComment', comment));
  const comments = await value(await f.call('ListIssueComments', comment));
  assert.equal(comments.comments.length, 1); assert.equal(comments.comments[0].id, posted.comment.id);
  assert.equal((await value(await f.call('GetIssue', { repository: key, number: 1 }))).issue.comments, 1);
  const mutation = await value(await f.call('GetIssueMutation', { idempotencyKey: comment.idempotencyKey }));
  assert.equal(mutation.comment.id, posted.comment.id);
  const batch = f.env.DB.batch.bind(f.env.DB); let lose = true;
  f.env.DB.batch = async statements => { const result = await batch(statements); if (lose) { lose = false; throw Error('response lost after commit'); } return result; };
  const lost = { ...input, title: 'Persisted once', idempotencyKey: nonce() };
  assert.equal((await f.call('CreateIssue', lost)).status, 503);
  assert.equal((await value(await f.call('CreateIssue', lost))).issue.number, 2);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussions').get().n, 2);
});

test('native private collaboration denies foreign IDs, revoked readers and key theft', async t => {
  const f = await fixture(t); await f.create();
  const input = { repository: key, repositoryId: '1', title: 'Private', body: '', idempotencyKey: nonce() };
  const created = await value(await f.call('CreateIssue', input));
  assert.equal((await f.call('GetIssue', { repository: key, number: 1 }, readerToken)).status, 404);
  assert.equal((await f.call('GetIssueMutation', { idempotencyKey: input.idempotencyKey }, readerToken)).status, 404);
  const grant = { repository: key, repositoryId: '1', userId: '2', role: 'read' };
  await value(await f.call('', grant, ownerToken, '/native/repository-grant'));
  const comment = { repository: key, repositoryId: '1', issueId: created.issue.id, number: 1, body: 'Reader reply', idempotencyKey: nonce() };
  await value(await f.call('CreateIssueComment', comment, readerToken));
  assert.equal((await f.call('UpdateIssue', { ...input, issueId: created.issue.id, number: 1, expectedRevision: created.issue.revision, title: 'Unauthorized', idempotencyKey: nonce() }, readerToken)).status, 404);
  assert.equal((await f.call('CreateIssueComment', { ...comment, issueId: '999', idempotencyKey: nonce() }, readerToken)).status, 404);
  assert.equal((await f.call('CreateIssue', { ...input, repositoryId: '999', idempotencyKey: nonce() })).status, 404);
  await value(await f.call('', { ...grant, role: 'none' }, ownerToken, '/native/repository-grant'));
  assert.equal((await f.call('GetIssueMutation', { idempotencyKey: comment.idempotencyKey }, readerToken)).status, 404);
  assert.equal((await f.call('CreateIssueComment', comment, readerToken)).status, 404);
});

async function pullFixture(t) {
  const f = await fixture(t); await f.create();
  t.mock.method(globalThis, 'fetch', f.providerFetch);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'b'.repeat(40)]]);
  const input = { repository: key, repositoryId: '1', sourceRepository: key, sourceRepositoryId: '1',
    baseBranch: 'main', headBranch: 'feature', baseCommitId: commit, headCommitId: 'b'.repeat(40), title: 'Proposal', body: 'Change', idempotencyKey: nonce() };
  const created = await value(await f.call('CreatePullRequest', input));
  const grant = { repository: key, repositoryId: '1', userId: '2', role: 'read' };
  await value(await f.call('', grant, ownerToken, '/native/repository-grant'));
  return { ...f, input, created, grant };
}

async function evidenceFixture(t) {
  const f = await pullFixture(t), messages = [], objects = new Map(), workflows = new Set();
  let calls = 0, puts = 0;
  Object.assign(f.env, { EVIDENCE_DAILY_LIMIT: '2', EVIDENCE_WORKFLOW_NAME: 'test-evidence', EVIDENCE_QUEUE_NAME: 'test-evidence',
    EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'test-gateway',
    EVIDENCE_QUEUE: { async send(body) { messages.push(body); } },
    EVIDENCE_BUCKET: {
      async put(key, value, options) { assert.equal(options.onlyIf.etagDoesNotMatch, '*'); puts++; if (objects.has(key)) return null; objects.set(key, value); return {}; },
      async get(key) { const value = objects.get(key); return value === undefined ? null : { size: new TextEncoder().encode(value).length, async text() { return value; } }; },
    },
    AI: { async run(model, prompt, options) {
      calls++; assert.equal(model, '@cf/cloudflare/clef'); assert.equal(options.gateway.collectLog, false); assert.equal(options.gateway.skipCache, true);
      assert.equal(prompt.state.head, 'b'.repeat(40)); assert.equal(JSON.stringify(prompt).includes(ownerToken), false);
      return { answers: { next: { type: 'choice', choice: 'run_tests', probabilities: { run_tests: 1, inspect_changes: 0, resolve_feedback: 0 } } }, usage: { input_tokens: 40 } };
    } },
    workflow: {
      async create({ id, params }) { assert.equal(params.jobId, id); if (workflows.has(id)) throw Error('Exists'); workflows.add(id); return { id }; },
      async get(id) { return { async status() { if (!workflows.has(id)) throw Error('Absent'); return { status: 'running' }; } }; },
    },
  });
  const pr = f.created.pullRequest;
  const selection = { repository: key, repositoryId: '1', pullRequestId: pr.id, number: pr.number, baseCommitId: pr.base.commitId, headCommitId: pr.head.commitId };
  const input = { action: 'create', selection, advice: true, idempotencyKey: nonce() };
  const call = (body, token = ownerToken) => f.call('', body, token, '/native/pr-evidence');
  return { ...f, selection, input, evidence: call, messages, objects, workflows, counts: () => ({ calls, puts }),
    read: (id, action = 'status', token = ownerToken) => call({ action, jobId: id, repository: key, repositoryId: '1' }, token) };
}

test('immutable indexes survive eviction and lost storage acknowledgements without weakening access', async t => {
  const f = await evidenceFixture(t); await f.sendPush(); f.env.READ_INDEXES = 'true';
  const put = f.env.EVIDENCE_BUCKET.put;
  let lose = true;
  f.env.EVIDENCE_BUCKET.put = async (...args) => { await put(...args); if (lose) { lose = false; throw Error('Lost R2 response'); } };
  f.env.EVIDENCE_BUCKET.delete = async key => { f.objects.delete(key); };
  const body = { repository: key, repositoryId: '1', ref: commit, page: { limit: 100 } };
  const first = await value(await f.call('GetContents', body));
  assert.equal(f.sql.prepare('SELECT state FROM repository_indexes').get().state, 'PENDING');
  const immutableKey = f.sql.prepare('SELECT key FROM repository_indexes').get().key;
  const recovered = await reconcileIndexes(f.env); assert.equal(recovered.published, 1);
  assert.equal(f.sql.prepare('SELECT state FROM repository_indexes').get().state, 'READY'); assert.equal(f.objects.size, 1);
  f.env.ARTIFACTS.get = async () => { throw Error('Immutable indexes avoid canonical RPCs after their source has been verified'); };
  assert.deepEqual(await value(await f.call('GetContents', body)), first);
  f.sql.prepare('DELETE FROM grants WHERE user_id=1').run(); assert.equal((await f.call('GetContents', body)).status, 404);
  f.sql.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  f.sql.prepare("UPDATE repository_indexes SET payload='{}'").run(); assert.equal((await f.call('GetContents', body)).status, 503);
  f.sql.prepare("UPDATE repository_indexes SET expires_at='2000-01-01T00:00:00Z'").run();
  assert.equal((await reconcileIndexes(f.env)).expired, 1); assert.equal(f.objects.has(immutableKey), false); assert.equal(f.sql.prepare('SELECT count(*) AS total FROM repository_indexes').get().total, 0);
});

test('shared PR history and diffs require current exact source and repository authority', async t => {
  const f = await pullFixture(t), pr = (await value(await f.call('GetPullRequest', { repository: key, number: 1 }))).pullRequest;
  assert.equal(pr.mergeBaseCommitId, commit);
  const selection = { repository: key, repositoryId: '1', pullRequestId: pr.id, number: 1, baseCommitId: pr.base.commitId, headCommitId: pr.head.commitId };
  const history = await value(await f.call('ListPullRequestCommits', { selection }, readerToken));
  assert.deepEqual(history.selection, selection); assert.deepEqual(history.commits.map(c => c.sha), ['b'.repeat(40)]);
  const observed = await value(await f.call('GetPullRequestDiff', selection, readerToken));
  assert.equal(observed.mergeBaseCommitId, commit); assert.equal(observed.rawDiff, ''); assert.equal(observed.byteSize, 0);
  const root = await value(await f.call('GetCommitDiff', { repository: key, commitId: commit }));
  assert.equal(root.base, 'COMMIT_DIFF_BASE_ROOT'); assert.equal(root.byteSize, Buffer.byteLength(root.rawDiff)); assert.match(root.rawDiff, /hello native/);
  assert.equal((await f.call('GetCommitDiff', { repository: key, commitId: 'main' })).status, 400);
  assert.equal((await f.call('GetPullRequestDiff', { ...selection, repositoryId: '999' })).status, 404);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.equal((await f.call('GetPullRequestDiff', selection)).status, 412);
  assert.equal((await f.call('ListPullRequestCommits', { selection })).status, 412);
  f.sql.prepare('DELETE FROM grants WHERE user_id=2').run();
  assert.equal((await f.call('GetPullRequestDiff', selection, readerToken)).status, 404);
  assert.equal((await f.call('GetCommitDiff', { repository: key, commitId: commit }, readerToken)).status, 404);
});

test('shared PR creation receipts and named comparisons match the portable UI contracts', async t => {
  const f = await pullFixture(t), pr = f.created.pullRequest, mutation = f.created.mutation;
  assert.equal(mutation.issueId, ''); assert.equal(mutation.observedResultId, pr.id); assert.equal(mutation.observedNumber, pr.number);
  const selection = { ...f.input }; for (const field of ['title', 'body', 'idempotencyKey']) delete selection[field];
  const observed = await value(await f.call('GetRepositoryComparison', { selection }, readerToken));
  assert.deepEqual(observed.selection, selection); assert.equal(observed.commits[0].sha, 'b'.repeat(40));
  assert.equal((await f.call('GetRepositoryComparison', { selection: { ...selection, sourceRepositoryId: '999' } })).status, 404);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.equal((await f.call('GetRepositoryComparison', { selection })).status, 412);
  f.sql.prepare('DELETE FROM grants WHERE user_id=2').run();
  assert.equal((await f.call('GetRepositoryComparison', { selection }, readerToken)).status, 404);
});

test('native shared stars preserve user, repository and workspace ownership with explicit desired state', async t => {
  const f = await fixture(t); await f.create();
  const selected = { repository: key, repositoryId: '1' };
  const first = (await value(await f.call('GetRepositoryStar', selected))).preference;
  assert.equal(first.ownerId, '1'); assert.equal(first.starred, false);
  const desired = { ...selected, ownerId: '1', nativeUserId: '1', starred: true };
  assert.equal((await value(await f.call('SetRepositoryStar', desired))).preference.starsCount, '1');
  assert.equal((await value(await f.call('SetRepositoryStar', desired))).preference.starsCount, '1');
  assert.equal((await f.call('SetRepositoryStar', { ...desired, nativeUserId: '2' })).status, 404);
  assert.equal((await f.call('SetRepositoryStar', { ...desired, ownerId: '999' })).status, 404);
  assert.equal((await f.call('SetRepositoryStar', { ...desired, starred: undefined })).status, 400);
  assert.equal((await f.call('GetRepositoryStar', selected, readerToken)).status, 404);
  f.sql.prepare("INSERT INTO grants VALUES(1,2,'read')").run();
  assert.equal((await value(await f.call('SetRepositoryStar', { ...desired, nativeUserId: '2' }, readerToken))).preference.starsCount, '2');
  f.sql.prepare('DELETE FROM grants WHERE user_id=2').run();
  assert.equal((await f.call('GetRepositoryStar', selected, readerToken)).status, 404);
  assert.equal((await value(await f.call('SetRepositoryStar', { ...desired, starred: false }))).preference.starsCount, '1');
});

test('native profiles are own-only, revision fenced and retain Access identity; workspace enrollment is exact', async t => {
  const f = await fixture(t), profilePath = '/rpc/golf.v1.ProfileService/';
  const first = (await value(await f.call('', {}, ownerToken, profilePath + 'GetProfile'))).profile;
  const edited = await value(await f.call('', { userId: '1', expectedRevision: first.revision, fullName: 'Alice Example', bio: 'Native Golf' }, ownerToken, profilePath + 'UpdateProfile'));
  assert.equal(edited.profile.fullName, 'Alice Example'); assert.notEqual(edited.profile.revision, first.revision);
  assert.equal((await f.call('', { userId: '2', expectedRevision: first.revision, fullName: 'Other' }, ownerToken, profilePath + 'UpdateProfile')).status, 404);
  assert.equal((await f.call('', { userId: '1', expectedRevision: first.revision, fullName: 'Stale' }, ownerToken, profilePath + 'UpdateProfile')).status, 412);
  assert.equal((await f.call('', { userId: '1', expectedRevision: edited.profile.revision, website: 'javascript:alert(1)' }, ownerToken, profilePath + 'UpdateProfile')).status, 400);
  const session = await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.SessionService/GetSession'));
  assert.equal(session.user.fullName, 'Alice Example'); assert.equal(session.user.login, 'alice'); assert.equal(f.sql.prepare('SELECT email FROM users WHERE id=1').get().email, null);
  const path = '/rpc/golf.v1.OrganizationService/';
  assert.equal((await value(await f.call('', {}, readerToken, path + 'ListOrganizations'))).organizations[0].name, 'alice');
  assert.equal((await f.call('', { organization: 'other' }, ownerToken, path + 'GetOrganization')).status, 404);
  f.env.ARTIFACTS_NAMESPACE = 'other-space';
  assert.equal((await f.call('', {}, ownerToken, path + 'ListOrganizations')).status, 412);
});

test('unallocated live streams return unimplemented instead of retryable JSON grammar errors', async t => {
  const f = await fixture(t);
  const response = await handle(new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.RepositoryActivityService/WatchRepository', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/connect+proto' }, body: new Uint8Array([0, 0, 0, 0, 0]),
  }), f.env);
  assert.equal(response.status, 200);
  const { createClient, Code } = await import('../../web/node_modules/@connectrpc/connect/dist/esm/index.js');
  const { createConnectTransport } = await import('../../web/node_modules/@connectrpc/connect-web/dist/esm/index.js');
  const { EmptySchema } = await import('../../web/node_modules/@bufbuild/protobuf/dist/esm/wkt/index.js');
  const RepositoryActivityService = { typeName:'golf.v1.RepositoryActivityService', methods:[] };
  RepositoryActivityService.methods.push({name:'WatchRepository',localName:'watchRepository',methodKind:'server_streaming',input:EmptySchema,output:EmptySchema,parent:RepositoryActivityService});
  for (const useBinaryFormat of [true, false]) {
    const client = createClient(RepositoryActivityService, createConnectTransport({ baseUrl: f.env.PUBLIC_ORIGIN + "/rpc", useBinaryFormat,
      fetch: async (url, init) => { const request = new Request(url, init); request.headers.set('Authorization', 'Bearer ' + ownerToken); const result=await handle(request, f.env); assert.equal(result.status,200,await result.clone().text()); return result; } }));
    await assert.rejects(async () => { for await (const event of client.watchRepository({})) assert.fail('Unexpected stream event'); }, error => error.code === Code.Unimplemented);
  }
});

test('native evidence snapshots are queued once, workflow-deduplicated and privately verified on R2', async t => {
  const f = await evidenceFixture(t);
  assert.equal((await f.evidence(f.input, readerToken)).status, 404);
  const job = (await value(await f.evidence(f.input))).job;
  assert.equal(job.state, 'QUEUED'); assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0], { jobId: job.id });
  assert.equal((await value(await f.evidence(f.input))).job.id, job.id); assert.equal(f.messages.length, 1);
  assert.equal((await f.evidence({ ...f.input, advice: false })).status, 409);
  assert.equal((await f.read(job.id, 'report')).status, 412);
  let ack = 0, retry = 0;
  const message = { body: f.messages[0], ack() { ack++; }, retry() { retry++; } };
  await consumeEvidence({ queue: 'test-evidence', messages: [message, message] }, f.env, { evidence: f.advance });
  assert.equal(ack, 2); assert.equal(retry, 0); assert.equal(f.workflows.size, 1);
  await f.advance(job.id, 'advice'); await f.advance(job.id, 'advice');
  assert.equal(f.counts().calls, 1);
  await f.advance(job.id, 'store'); await f.advance(job.id, 'store');
  assert.equal(f.counts().puts, 1);
  const report = await value(await f.read(job.id, 'report', readerToken));
  assert.equal(report.report.jobId, job.id); assert.equal(report.report.advisoryOnly, true);
  assert.equal(report.report.advice.state, 'SUCCEEDED'); assert.equal(report.job.stale, false);
  const stored = [...f.objects.values()][0]; assert.equal(await digest(stored), report.job.reportSha256);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.equal((await value(await f.read(job.id, 'report'))).job.stale, true);
  assert.equal([...f.objects.values()][0], stored);
  assert.equal((await f.evidence({ ...f.input, idempotencyKey: nonce() })).status, 412);
  await value(await f.call('', { ...f.grant, role: 'none' }, ownerToken, '/native/repository-grant'));
  assert.equal((await f.read(job.id, 'report', readerToken)).status, 404);
  assert.equal((await f.read(job.id, 'status', readerToken)).status, 404);
});

function allocateTests(f) {
  const tasks = new Map(); let admissions = 0;
  f.env.TEST_EXECUTION_ENABLED = 'true'; f.env.TEST_MODULE = 'test_calc';
  f.env.TEST_POLICY_SHA256 = 'e'.repeat(64);
  f.env.testTasks = { getByName(id) {
    return {
      async create(input) {
        if (!tasks.has(id)) { admissions++; tasks.set(id, { ...input, state: 'RUNNING', deniedRequests: 0 }); }
        else assert.deepEqual(input, Object.fromEntries(Object.keys(input).map(k => [k, tasks.get(id)[k]])));
      },
      async status() { return tasks.get(id) || { state: 'ABSENT' }; },
      async cancel() {
        const r = tasks.get(id);
        if (!r) return { state: 'ABSENT' };
        Object.assign(r, { state: 'CANCELLED', cleanup: 'destroyed', exitCode: null, stdout: '', stderr: '', finishedAt: Date.now() });
        return r;
      },
    };
  } };
  return { tasks, admissions: () => admissions };
}

test('PR tests require allocation, deduplicate execution and bind private results to exact source', async t => {
  const f = await evidenceFixture(t), input = { ...f.input, advice: false, runTests: true };
  assert.equal((await f.evidence(input)).status, 412);
  assert.equal((await f.evidence({ ...input, runTests: 'true' })).status, 400);
  const execution = allocateTests(f);
  assert.equal((await f.evidence(input, readerToken)).status, 404);
  const job = (await value(await f.evidence(input))).job;
  assert.equal(job.testState, 'REQUESTED');
  assert.equal((await f.evidence({ ...input, runTests: false })).status, 409);
  await assert.rejects(f.advance(job.id, 'store'), /Test stage unfinished/);
  for (let i = 0; i < 2; i++) assert.equal((await f.advance(job.id, 'tests')).state, 'RUNNING');
  assert.equal(execution.admissions(), 1);
  const task = execution.tasks.get(job.id);
  assert.equal(task.contract, 'golf.native.pr-test.v1');
  assert.equal(task.commitId, f.selection.headCommitId); assert.equal(task.treeId, 'f'.repeat(40)); assert.equal(task.branch, 'feature');
  const get = new Request(task.remote + '/info/refs?service=git-upload-pack', { headers: { Authorization: 'Bearer attacker', Cookie: 'private', 'Git-Protocol': 'version=2' } });
  const readGit = (url, options) => { assert.equal(options.headers['Git-Protocol'], 'version=2'); assert.equal(options.headers.Cookie, undefined); return f.providerFetch(url, options); };
  assert.equal((await testGit(f.env, job.id, get, f.env.workflow, readGit)).status, 200);
  assert.equal(f.tokens.size, 0);
  assert.equal((await testGit(f.env, job.id, new Request(task.remote + '/git-receive-pack', { method: 'POST' }), f.env.workflow, f.providerFetch)).status, 403);
  assert.equal((await testGit(f.env, job.id, new Request('https://example.com/'), f.env.workflow, f.providerFetch)).status, 403);
  Object.assign(task, { state: 'PASSED', cleanup: 'destroyed', exitCode: 0, stdout: '', stderr: 'Ran 2 tests\nOK\n', finishedAt: Date.now(), credential: ownerToken });
  await f.advance(job.id, 'tests'); await f.advance(job.id, 'advice'); await f.advance(job.id, 'store');
  const result = await value(await f.read(job.id, 'report', readerToken));
  assert.equal(result.report.tests.state, 'PASSED'); assert.equal(result.report.tests.commitId, f.selection.headCommitId);
  assert.equal(result.report.tests.credential, undefined); assert.equal(result.job.testState, 'PASSED');
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.equal((await value(await f.read(job.id, 'report'))).job.stale, true);
  assert.equal((await testGit(f.env, job.id, get, f.env.workflow, f.providerFetch)).status, 403);
});

test('native GitLab workflow admission binds the exact PR blob and keeps scripts out of reports', async t => {
  const f = await evidenceFixture(t), execution = allocateTests(f), blobId = '9'.repeat(40);
  delete f.env.TEST_MODULE;
  Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'gitlab', TEST_WORKFLOW_PATH: '.gitlab-ci.yml', TEST_POLICY_SHA256: '8'.repeat(64) });
  const config = await value(await f.call('', {}, ownerToken, '/native/config'));
  assert.equal(config.testWorkflowFormat, 'gitlab'); assert.equal(config.testWorkflowPath, '.gitlab-ci.yml');
  const capabilities = await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'));
  assert.match(capabilities.capabilities.find(c => c.id === 'native-pr-tests').reason, /GitLab shell workflow/);
  let source = 'check:\n  before_script: export VALUE=ready\n  script: test "$VALUE" = ready\n  after_script: echo cleanup\n';
  const get = f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get = async name => {
    const repo = await get(name), readTree = repo.readTree, readBlob = repo.readBlob;
    return { ...repo,
      async readTree(hash) { const entries = await readTree(hash); return hash === 'f'.repeat(40) ? [...entries, { name: '.gitlab-ci.yml', hash: blobId, type: 'blob' }] : entries; },
      async readBlob(hash) { return hash === blobId ? new Blob([source]) : readBlob(hash); },
    };
  };
  const input = { ...f.input, advice: false, runTests: true };
  const job = (await value(await f.evidence(input))).job;
  await f.advance(job.id, 'tests');
  const task = execution.tasks.get(job.id);
  assert.equal(task.contract, 'golf.native.workflow-shell.v1');
  assert.equal(task.workflow.blobId, blobId);
  assert.equal(task.workflow.plan.steps[0].run, 'export VALUE=ready\ntest "$VALUE" = ready');
  assert.equal(task.workflow.plan.afterScript, 'echo cleanup');
  Object.assign(task, { state: 'PASSED', cleanup: 'destroyed', exitCode: 0, stdout: 'ok', stderr: '', finishedAt: Date.now() });
  await f.advance(job.id, 'tests'); await f.advance(job.id, 'advice'); await f.advance(job.id, 'store');
  const report = await value(await f.read(job.id, 'report'));
  assert.equal(report.report.tests.workflowSha256, task.workflowSha256);
  assert.equal(JSON.stringify(report).includes('export VALUE=ready'), false);
  source = 'check:\n  script: echo approved\n  rules: [{ when: always }]\n';
  assert.equal((await f.evidence({ ...input, idempotencyKey: nonce() })).status, 412);
  assert.equal(execution.admissions(), 1);
  const pinned = 'alpine:3.23@sha256:'+'a'.repeat(64);
  source = `check:\n  image: ${pinned}\n  script: echo pinned\n`;
  f.env.TEST_IMAGE_REF = 'alpine:3.23@sha256:'+'b'.repeat(64);
  assert.equal((await f.evidence({ ...input, idempotencyKey: nonce() })).status, 412);
  f.env.TEST_IMAGE_REF = pinned;
  const pinnedJob = (await value(await f.evidence({ ...input, idempotencyKey: nonce() }))).job;
  await f.advance(pinnedJob.id,'tests');
  assert.equal(execution.tasks.get(pinnedJob.id).workflow.plan.image,pinned);
});

test('test failures are evidence, while malformed identity and cleanup failure cannot become success', async t => {
  const f = await evidenceFixture(t), execution = allocateTests(f);
  const job = (await value(await f.evidence({ ...f.input, advice: false, runTests: true }))).job;
  await f.advance(job.id, 'tests');
  const task = execution.tasks.get(job.id);
  Object.assign(task, { state: 'PASSED', cleanup: 'failed', exitCode: 0, stdout: '', stderr: '', finishedAt: Date.now() });
  await assert.rejects(f.advance(job.id, 'tests'), /Invalid test execution/);
  task.cleanup = 'destroyed'; task.commitId = '0'.repeat(40);
  await assert.rejects(f.advance(job.id, 'tests'));
  task.commitId = f.selection.headCommitId; task.state = 'FAILED'; task.exitCode = 1; task.stderr = 'FAIL\n';
  await f.advance(job.id, 'finish-tests'); await f.advance(job.id, 'advice'); await f.advance(job.id, 'store');
  const result = await value(await f.read(job.id, 'report'));
  assert.equal(result.job.state, 'SUCCEEDED'); assert.equal(result.report.tests.state, 'FAILED');
});

test('cancellation fences Git first and authority changes deny another test dispatch', async t => {
  const f = await evidenceFixture(t), execution = allocateTests(f);
  const job = (await value(await f.evidence({ ...f.input, advice: false, runTests: true }))).job;
  await f.advance(job.id, 'tests');
  assert.equal((await f.read(job.id, 'cancel', readerToken)).status, 404);
  assert.equal((await value(await f.read(job.id, 'cancel'))).job.state, 'REFUSED');
  assert.equal(execution.tasks.get(job.id).cleanup, 'destroyed');
  assert.equal((await f.advance(job.id, 'authorize-test')).state, 'REFUSED');
  const next = (await value(await f.evidence({ ...f.input, advice: false, runTests: true, idempotencyKey: nonce() }))).job;
  f.env.TEST_MODULE = 'other_module';
  assert.equal((await f.advance(next.id, 'tests')).state, 'REFUSED');
  assert.equal(execution.admissions(), 1);
});

test('workspace container concurrency is bounded and escaped output cannot publish an unreadable report', async t => {
  const f = await evidenceFixture(t), execution = allocateTests(f);
  f.env.EVIDENCE_DAILY_LIMIT = '20';
  const jobs = [];
  for (let i = 0; i < 3; i++) jobs.push((await value(await f.evidence({ ...f.input, advice: false, runTests: true, idempotencyKey: nonce() }))).job);
  await f.advance(jobs[0].id, 'tests'); await f.advance(jobs[1].id, 'tests');
  assert.equal((await f.advance(jobs[2].id, 'tests')).state, 'REFUSED'); assert.equal(execution.admissions(), 2);
  const task = execution.tasks.get(jobs[0].id);
  Object.assign(task, { state: 'PASSED', cleanup: 'destroyed', exitCode: 0, stdout: '\0'.repeat(65536), stderr: '', finishedAt: Date.now() });
  await f.advance(jobs[0].id, 'tests'); await f.advance(jobs[0].id, 'advice');
  await assert.rejects(f.advance(jobs[0].id, 'store'), /Serialized evidence report exceeds/);
  assert.equal(f.objects.size, 0); assert.equal((await f.read(jobs[0].id, 'report')).status, 412);
});

test('concurrent evidence replay preserves one job and the daily allocation cannot oversubscribe', async t => {
  const f = await evidenceFixture(t);
  f.env.EVIDENCE_DAILY_LIMIT = '1';
  const replay = await Promise.all(Array.from({ length: 6 }, () => f.evidence(f.input)));
  assert.deepEqual(replay.map(response => response.status), Array(6).fill(200));
  const jobs = await Promise.all(replay.map(response => value(response)));
  assert.equal(new Set(jobs.map(result => result.job.id)).size, 1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM evidence_jobs').get().n, 1);
  assert.equal((await f.evidence({ ...f.input, advice: false })).status, 409);

  f.env.EVIDENCE_DAILY_LIMIT = '2';
  const competing = await Promise.all(Array.from({ length: 6 }, () => f.evidence({ ...f.input, idempotencyKey: nonce() })));
  assert.deepEqual(competing.map(response => response.status).sort(), [200, 429, 429, 429, 429, 429]);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM evidence_jobs').get().n, 2);
  assert.equal(f.counts().calls, 0);
});

test('queue loss keeps a replayable outbox and daily allocations include ambiguous jobs', async t => {
  const f = await evidenceFixture(t), send = f.env.EVIDENCE_QUEUE.send;
  f.env.EVIDENCE_QUEUE.send = async body => { await send(body); throw Error('Lost acknowledgement'); };
  assert.equal((await f.evidence(f.input)).status, 503);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM evidence_jobs').get().n, 1);
  f.env.EVIDENCE_QUEUE.send = send;
  const job = (await value(await f.evidence(f.input))).job;
  assert.equal(f.messages.length, 2); assert.deepEqual(f.messages[0], f.messages[1]);
  await f.advance(job.id, 'start'); await f.advance(job.id, 'start'); assert.equal(f.workflows.size, 1);
  await value(await f.evidence({ ...f.input, advice: false, idempotencyKey: nonce() }));
  assert.equal((await f.evidence({ ...f.input, idempotencyKey: nonce() })).status, 429);
  assert.equal((await value(await f.evidence(f.input))).job.id, job.id);
  assert.equal(f.counts().calls, 0);
});

test('Analytics Engine projects sampled completion measurements without private content or quota authority', async t => {
  const f = await evidenceFixture(t), points = [];
  f.env.USAGE_ANALYTICS = { writeDataPoint: point => points.push(point) };
  const job = (await value(await f.evidence(f.input))).job;
  await f.advance(job.id, 'advice'); await f.advance(job.id, 'store'); await f.advance(job.id, 'store');
  assert.equal(points.length, 1); assert.match(points[0].indexes[0], /^[a-f0-9]{64}$/);
  assert.deepEqual(points[0].blobs, ['golf.native.pr-evidence.v1', '1', 'NONE', 'SUCCEEDED']);
  assert.equal(points[0].doubles[0], 1); assert.ok(points[0].doubles[1] > 0); assert.ok(points[0].doubles[2] >= 0);
  assert.deepEqual(points[0].doubles.slice(3), [40, -1]);
  assert.equal(JSON.stringify(points).includes(ownerToken), false); assert.equal(JSON.stringify(points).includes(f.input.selection.repository.owner), false);
  f.env.USAGE_ANALYTICS.writeDataPoint = () => { throw Error('Telemetry unavailable'); };
  const next = (await value(await f.evidence({ ...f.input, advice: false, idempotencyKey: nonce() }))).job;
  await f.advance(next.id, 'advice'); await f.advance(next.id, 'store');
  assert.equal((await value(await f.read(next.id))).job.state, 'SUCCEEDED');
  assert.equal((await f.evidence({ ...f.input, idempotencyKey: nonce() })).status, 429);
});

test('inference reservations and unknown outcomes survive retry without another model dispatch', async t => {
  const f = await evidenceFixture(t);
  let calls = 0;
  f.env.AI.run = async () => { calls++; throw Error('Provider may have billed'); };
  const first = (await value(await f.evidence(f.input))).job;
  await f.advance(first.id, 'advice'); await f.advance(first.id, 'advice');
  await f.advance(first.id, 'store');
  assert.equal(calls, 1);
  assert.equal((await value(await f.read(first.id, 'report'))).report.advice.state, 'UNKNOWN');
  const second = (await value(await f.evidence({ ...f.input, idempotencyKey: nonce() }))).job;
  f.sql.prepare("UPDATE evidence_jobs SET advice_state='RESERVED' WHERE id=?").run(second.id);
  await f.advance(second.id, 'advice'); await f.advance(second.id, 'store');
  assert.equal(calls, 1);
  assert.equal((await value(await f.read(second.id, 'report'))).report.advice.state, 'UNKNOWN');
});

test('lost R2 acknowledgement reconciles exact bytes; corrupt objects never become evidence', async t => {
  const f = await evidenceFixture(t), original = f.env.EVIDENCE_BUCKET.put;
  const job = (await value(await f.evidence({ ...f.input, advice: false }))).job;
  await f.advance(job.id, 'advice');
  f.env.EVIDENCE_BUCKET.put = async (...args) => { await original(...args); throw Error('PUT response lost'); };
  await assert.rejects(f.advance(job.id, 'store'));
  assert.equal((await value(await f.read(job.id))).job.state, 'QUEUED');
  assert.equal(f.objects.size, 1);
  f.env.EVIDENCE_BUCKET.put = original;
  await f.advance(job.id, 'store'); assert.equal(f.objects.size, 1);
  assert.equal((await f.read(job.id, 'report')).status, 200);
  for (const key of f.objects.keys()) f.objects.set(key, 'corrupted');
  assert.equal((await f.read(job.id, 'report')).status, 503);
});

test('native evidence stops on authority loss, policy removal, stale refs and deadline', async t => {
  const f = await evidenceFixture(t);
  f.env.EVIDENCE_DAILY_LIMIT = '20';
  const jobs = [];
  for (let i = 0; i < 4; i++) jobs.push((await value(await f.evidence({ ...f.input, idempotencyKey: nonce() }))).job);
  f.sql.prepare("UPDATE evidence_jobs SET expires_at='2000-01-01' WHERE id=?").run(jobs[0].id);
  assert.equal((await f.advance(jobs[0].id, 'start')).state, 'EXPIRED');
  f.env.EVIDENCE_ALLOW_AI = 'false';
  assert.equal((await f.advance(jobs[1].id, 'start')).state, 'REFUSED');
  assert.equal((await f.evidence({ ...f.input, idempotencyKey: nonce() })).status, 412);
  f.env.EVIDENCE_ALLOW_AI = 'true';
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.equal((await f.advance(jobs[2].id, 'start')).state, 'REFUSED');
  f.sql.prepare('UPDATE users SET active=0 WHERE id=1').run();
  assert.equal((await f.advance(jobs[3].id, 'start')).state, 'REFUSED');
  assert.equal(f.workflows.size, 0); assert.equal(f.counts().calls, 0); assert.equal(f.objects.size, 0);
  await assert.rejects(consumeEvidence({ queue: 'foreign-queue', messages: [] }, f.env, { evidence: f.advance }));
});

test('evidence dispatch limits and ambiguous workflow creation preserve the original identity', async t => {
  const f = await evidenceFixture(t);
  let dispatches = 0;
  f.env.EVIDENCE_QUEUE.send = async () => { dispatches++; throw Error('Queue unavailable'); };
  for (let i = 0; i < 3; i++) assert.equal((await f.evidence(f.input)).status, 503);
  assert.equal((await f.evidence(f.input)).status, 412); assert.equal(dispatches, 3);
  const job = f.sql.prepare('SELECT * FROM evidence_jobs').get();
  const create = f.env.workflow.create;
  f.env.workflow.create = async options => { await create(options); throw Error('Create acknowledgement lost'); };
  assert.equal((await f.advance(job.id, 'start')).id, job.id); assert.equal(f.workflows.size, 1);
  await f.advance(job.id, 'advice'); await f.advance(job.id, 'store');
  assert.equal((await value(await f.read(job.id))).job.state, 'SUCCEEDED');
  assert.equal(f.counts().calls, 1);
  let ack = 0;
  await consumeEvidence({ queue: 'test-evidence', messages: [{ body: { jobId: job.id, token: 'untrusted' }, ack() { ack++; } }] }, f.env,
    { evidence() { throw Error('Must not dispatch'); } });
  assert.equal(ack, 1);
});

test('advisory deadlines and malformed responses retain uncertainty without re-inference', async t => {
  const f = await evidenceFixture(t);
  let calls = 0;
  f.env.AI.run = () => { calls++; return new Promise(() => {}); };
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, duration) => { assert.equal(duration, 25000); return timer(callback, 1); });
  const job = (await value(await f.evidence(f.input))).job;
  await f.advance(job.id, 'advice'); await f.advance(job.id, 'advice'); await f.advance(job.id, 'store');
  assert.equal(calls, 1); assert.equal((await value(await f.read(job.id, 'report'))).report.advice.state, 'UNKNOWN');
  f.env.AI.run = async () => { calls++; return { answers: { next: 'merge now' } }; };
  const next = (await value(await f.evidence({ ...f.input, idempotencyKey: nonce() }))).job;
  await f.advance(next.id, 'advice'); await f.advance(next.id, 'store');
  assert.equal(calls, 2); assert.equal((await value(await f.read(next.id, 'report'))).report.advice.state, 'UNKNOWN');
});

test('queued evidence rechecks the original writer grant and cannot widen an inactive allocation', async t => {
  const f = await evidenceFixture(t);
  const queue = f.env.EVIDENCE_QUEUE;
  f.env.EVIDENCE_QUEUE = null;
  assert.equal((await f.evidence(f.input)).status, 412);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM evidence_jobs').get().n, 0);
  f.env.EVIDENCE_QUEUE = queue;
  await value(await f.call('', { ...f.grant, role: 'write' }, ownerToken, '/native/repository-grant'));
  const job = (await value(await f.evidence(f.input, readerToken))).job;
  await value(await f.call('', { ...f.grant, role: 'none' }, ownerToken, '/native/repository-grant'));
  assert.equal((await f.advance(job.id, 'start')).state, 'REFUSED');
  assert.equal(f.workflows.size, 0); assert.equal(f.counts().calls, 0);
  assert.equal((await f.read(job.id, 'status', readerToken)).status, 404);
});

test('typed Clef output is bounded, validated and projects only observed usage', async t => {
  const f = await evidenceFixture(t);
  f.env.EVIDENCE_DAILY_LIMIT = '20';
  const next = { type: 'choice', choice: 'run_tests', probabilities: { inspect_changes: 0, run_tests: 1, resolve_feedback: 0 } };
  const invalid = [
    { answers: { next: { ...next, choice: 'merge' } } },
    { answers: { next: { ...next, probabilities: { inspect_changes: 0.5, run_tests: 0.5, resolve_feedback: 0.5 } } } },
    { answers: { next: { ...next, probabilities: { inspect_changes: NaN, run_tests: 1, resolve_feedback: 0 } } } },
    { answers: { next }, usage: { input_tokens: '10' } },
  ];
  for (const result of invalid) {
    f.env.AI.run = async () => result;
    const job = (await value(await f.evidence({ ...f.input, idempotencyKey: nonce() }))).job;
    await f.advance(job.id, 'advice'); await f.advance(job.id, 'advice'); await f.advance(job.id, 'store');
    assert.equal((await value(await f.read(job.id, 'report'))).report.advice.state, 'UNKNOWN');
  }
  f.env.AI.run = async () => ({ answers: { next: { ...next, credential: ownerToken } }, usage: { input_tokens: 10, extra: 'not usage' } });
  const job = (await value(await f.evidence({ ...f.input, idempotencyKey: nonce() }))).job;
  await f.advance(job.id, 'advice'); await f.advance(job.id, 'store');
  const report = await value(await f.read(job.id, 'report'));
  assert.deepEqual(report.report.advice.answers.next, next);
  assert.deepEqual(report.report.advice.usage, { input_tokens: 10 });
  assert.equal(JSON.stringify(report).includes(ownerToken), false);
});

test('an R2 step that crosses the job deadline cannot publish a completed report', async t => {
  const f = await evidenceFixture(t), NativeDate = Date;
  let now = Date.now();
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  t.after(() => { globalThis.Date = NativeDate; });
  const job = (await value(await f.evidence({ ...f.input, advice: false }))).job;
  const put = f.env.EVIDENCE_BUCKET.put;
  f.env.EVIDENCE_BUCKET.put = async (...args) => { await put(...args); now += 600001; };
  await f.advance(job.id, 'advice');
  assert.equal((await f.advance(job.id, 'store')).state, 'EXPIRED');
  assert.equal(f.objects.size, 1);
  globalThis.Date = NativeDate;
  assert.equal((await f.read(job.id, 'report')).status, 412);
});

test('native proposals bind real refs; overall reviews become stale after a push', async t => {
  const f = await pullFixture(t), pr = f.created.pullRequest;
  assert.equal(pr.base.commitId, commit); assert.equal(pr.head.commitId, 'b'.repeat(40));
  assert.equal((await value(await f.call('CreatePullRequest', f.input))).pullRequest.id, pr.id);
  assert.equal((await f.call('CreatePullRequest', { ...f.input, idempotencyKey: nonce() })).status, 409);
  const review = { repository: key, repositoryId: '1', pullRequestId: pr.id, number: pr.number, expectedRevision: pr.revision,
    baseCommitId: pr.base.commitId, headCommitId: pr.head.commitId, state: 'PULL_REQUEST_REVIEW_STATE_APPROVED', body: '', idempotencyKey: nonce() };
  assert.equal((await f.call('CreatePullRequestReview', review)).status, 403);
  const approval = await value(await f.call('CreatePullRequestReview', review, readerToken));
  assert.equal(approval.review.stale, false); assert.equal(approval.review.official, false);
  assert.equal((await value(await f.call('CreatePullRequestReview', review, readerToken))).review.id, approval.review.id);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  const current = (await value(await f.call('GetPullRequest', { repository: key, number: pr.number }))).pullRequest;
  assert.equal(current.head.commitId, 'c'.repeat(40)); assert.notEqual(current.revision, pr.revision);
  const reviews = await value(await f.call('ListPullRequestReviews', { repository: key, number: pr.number }));
  assert.equal(reviews.reviews[0].stale, true);
  assert.equal((await f.call('CreatePullRequestReview', { ...review, idempotencyKey: nonce() }, readerToken)).status, 412);
  const receipt = await value(await f.call('GetPullRequestReviewMutation', { idempotencyKey: review.idempotencyKey }, readerToken));
  assert.equal(receipt.review.stale, true);
  assert.equal((await f.call('GetIssue', { repository: key, number: pr.number })).status, 404);
  const discussion = await value(await f.call('GetPullRequestDiscussion', { repository: key, number: pr.number }));
  assert.equal(discussion.issue.id, String(f.sql.prepare('SELECT discussion_id FROM pull_requests WHERE id=?').get(Number(pr.id)).discussion_id));
  assert.equal((await f.call('CreatePullRequest', { ...f.input, baseCommitId: 'c'.repeat(40), headBranch: 'other', idempotencyKey: nonce() })).status, 412);
  assert.equal(f.tokens.size, 0);
});

test('reported checks are admin-only, commit-bound and superseded per context', async t => {
  const f = await pullFixture(t), pr = f.created.pullRequest;
  const input = { repository: key, repositoryId: '1', commitId: pr.head.commitId, context: 'test/unit',
    state: 'REPORTED_CHECK_STATE_PENDING', description: 'Reported, not execution evidence', idempotencyKey: nonce() };
  const report = body => f.call('', body, ownerToken, '/native/repository-check');
  assert.equal((await f.call('', input, readerToken, '/native/repository-check')).status, 404);
  assert.equal((await report({ ...input, targetUrl: false, idempotencyKey: nonce() })).status, 400);
  await value(await report(input)); await value(await report(input));
  await value(await report({ ...input, state: 'REPORTED_CHECK_STATE_SUCCESS', idempotencyKey: nonce() }));
  const selection = { repository: key, repositoryId: '1', pullRequestId: pr.id, number: pr.number, baseCommitId: pr.base.commitId, headCommitId: pr.head.commitId };
  const checks = await value(await f.call('ListPullRequestChecks', { selection }));
  assert.equal(checks.checks.length, 1); assert.equal(checks.checks[0].state, 'REPORTED_CHECK_STATE_SUCCESS');
  assert.equal((await report({ ...input, targetUrl: 'javascript:alert(1)', idempotencyKey: nonce() })).status, 400);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.equal((await f.call('ListPullRequestChecks', { selection })).status, 412);
  const next = await value(await f.call('ListPullRequestChecks', { selection: { ...selection, headCommitId: 'c'.repeat(40) } }));
  assert.equal(next.checks.length, 0);
});

test('concurrent edits admit one revision and failed D1 batches leave no partial discussion', async t => {
  const f = await fixture(t); await f.create();
  const input = { repository: key, repositoryId: '1', title: 'Atomic', body: '', idempotencyKey: nonce() };
  const original = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = statements => original([...statements, f.env.DB.prepare("INSERT INTO users(id,login) VALUES(1,'duplicate')")]);
  assert.equal((await f.call('CreateIssue', input)).status, 503);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussions').get().n, 0);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM collaboration_operations').get().n, 0);
  f.env.DB.batch = original;
  const created = (await value(await f.call('CreateIssue', input))).issue;
  const change = { repository: key, repositoryId: '1', issueId: created.id, number: created.number, expectedRevision: created.revision, title: 'First' };
  const results = await Promise.all([
    f.call('UpdateIssue', { ...change, idempotencyKey: nonce() }),
    f.call('UpdateIssue', { ...change, title: 'Second', idempotencyKey: nonce() }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 412]);
  const observed = (await value(await f.call('GetIssue', { repository: key, number: created.number }))).issue;
  assert.equal(observed.title, 'First');
  const cleared = await value(await f.call('UpdateIssue', { ...change, title: undefined, body: '', expectedRevision: observed.revision, idempotencyKey: nonce() }));
  assert.equal(cleared.issue.body, '');
  const escaped = await value(await f.call('CreateIssue', { ...input, body: '\n'.repeat(12000), idempotencyKey: nonce() }));
  assert.equal(escaped.issue.body.length, 12000);
  assert.equal((await f.call('CreateIssue', { ...input, body: 'x'.repeat(100000), idempotencyKey: nonce() })).status, 429);
});

test('draft/closed proposals and unavailable live refs never admit a current review', async t => {
  const f = await pullFixture(t); let pr = f.created.pullRequest;
  const edit = changes => ({ repository: key, repositoryId: '1', pullRequestId: pr.id, number: pr.number, expectedRevision: pr.revision, idempotencyKey: nonce(), ...changes });
  const submit = () => ({ repository: key, repositoryId: '1', pullRequestId: pr.id, number: pr.number,
    expectedRevision: pr.revision, baseCommitId: pr.base.commitId, headCommitId: pr.head.commitId,
    state: 'PULL_REQUEST_REVIEW_STATE_COMMENT', body: 'Review', idempotencyKey: nonce() });
  assert.equal((await f.call('UpdatePullRequest', edit({ title: 'Reader cannot edit this proposal' }), readerToken)).status, 404);
  pr = (await value(await f.call('UpdatePullRequest', edit({ draft: true })))).pullRequest;
  assert.equal((await f.call('CreatePullRequestReview', submit(), readerToken)).status, 412);
  pr = (await value(await f.call('UpdatePullRequest', edit({ draft: false })))).pullRequest;
  pr = (await value(await f.call('UpdatePullRequest', edit({ state: 'ISSUE_STATE_CLOSED' })))).pullRequest;
  assert.equal((await f.call('CreatePullRequestReview', submit(), readerToken)).status, 412);
  assert.equal((await value(await f.call('ListPullRequests', { repository: key }))).pullRequests.length, 0);
  assert.equal((await value(await f.call('ListPullRequests', { repository: key, state: 'ISSUE_STATE_CLOSED' }))).pullRequests.length, 1);
  pr = (await value(await f.call('UpdatePullRequest', edit({ state: 'ISSUE_STATE_OPEN' })))).pullRequest;
  await value(await f.call('CreatePullRequestReview', submit(), readerToken));
  f.setRefs([['refs/heads/main', commit]]);
  pr = (await value(await f.call('GetPullRequest', { repository: key, number: pr.number }))).pullRequest;
  assert.equal(pr.head.retainedSnapshot, true);
  assert.equal((await f.call('CreatePullRequestReview', submit(), readerToken)).status, 412);
  assert.equal((await value(await f.call('ListPullRequestReviews', { repository: key, number: pr.number }))).reviews[0].stale, true);
  const issue = await value(await f.call('CreateIssue', { repository: key, repositoryId: '1', title: 'Second discussion', body: '', idempotencyKey: nonce() }));
  assert.equal(issue.issue.number, 2);
  assert.equal((await value(await f.call('ListIssues', { repository: key, query: { author: 'alice', search: 'Second' } }))).issues.length, 1);
  assert.equal((await value(await f.call('ListIssues', { repository: key, query: { labelNames: ['missing'] } }))).issues.length, 0);
});

function allocateAgents(f) {
  allocateTests(f);
  Object.assign(f.env, { AGENT_EXECUTION_ENABLED: 'true', AGENT_PATH: 'hello.txt', AGENT_POLICY_SHA256: 'd'.repeat(64) });
  const tasks = new Map(); let admissions = 0;
  f.env.agentTasks = { getByName(id) { return {
    async create(input) { if (!tasks.has(id)) { admissions++; tasks.set(id, { ...input, state: 'running' }); } else assert.deepEqual(input, Object.fromEntries(Object.keys(input).map(k => [k, tasks.get(id)[k]]))); },
    async status() { return tasks.get(id) || { state: 'ABSENT' }; },
    async cancel() { if (!tasks.has(id)) return { state: 'ABSENT' }; const r = tasks.get(id); Object.assign(r, agentValue(r, 'cancelled')); return r; },
  }; } };
  return { tasks, admissions: () => admissions };
}
function agentValue(input, state = 'succeeded') {
  return { role: input.jobId, state, base_commit: input.commitId, base_tree: input.treeId, allowed_path: input.allowedPath,
    started_at: Date.now() - 3, first_inference_at: Date.now() - 2, agent_completed_at: Date.now() - 1, policy_sha256: input.policySha256, cleanup: 'destroyed', finished_at: Date.now(), calls: 2, denied: 1,
    proposal_commit: 'c'.repeat(40), proposal_tree: 'f'.repeat(40), patch: 'review this proposal', events: [], tokens: 50,
    tests: { full: { exit_code: 1, stdout: '', stderr: 'Actual failed proposal test' } } };
}

test('native PR agent admission requires explicit policy, source, writer and bounded prompt', async t => {
  const f = await evidenceFixture(t), input = { ...f.input, advice: false, agent: { prompt: 'Improve the approved source file.' } };
  assert.equal((await f.evidence(input)).status, 412);
  const execution = allocateAgents(f);
  assert.equal((await f.evidence(input, readerToken)).status, 404);
  for (const agent of [null, {}, { prompt: '' }, { prompt: 'a'.repeat(16385) }, { prompt: 'Fix', remote: 'external' }]) assert.equal((await f.evidence({ ...input, agent })).status, 400);
  assert.equal((await f.evidence({ ...input, runTests: true })).status, 400);
  const job = (await value(await f.evidence(input))).job;
  assert.equal(job.agentState, 'REQUESTED'); assert.equal((await value(await f.evidence(input))).job.id, job.id);
  assert.equal((await f.evidence({ ...input, agent: { prompt: 'Different' } })).status, 409);
  await f.advance(job.id, 'agents'); await f.advance(job.id, 'agents');
  assert.equal(execution.admissions(), 1); assert.equal(f.forks(), 1);
  assert.equal(execution.tasks.get(job.id).commitId, f.selection.headCommitId);
  assert.match(execution.tasks.get(job.id).remote, new RegExp('repo-' + job.id.replaceAll('-', '') + '\\.git$'));
});

test('agent fork lost acknowledgement is inspected once; proposals need confirmed private fork publication', async t => {
  const f = await evidenceFixture(t), execution = allocateAgents(f);
  const job = (await value(await f.evidence({ ...f.input, advice: false, agent: { prompt: 'Improve the approved source.' } }))).job;
  f.loseFork(); await assert.rejects(f.advance(job.id, 'agents'), /Lost fork/);
  assert.equal(f.sql.prepare('SELECT agent_state FROM evidence_jobs').get().agent_state, 'FORK_PENDING');
  await f.advance(job.id, 'agents'); assert.equal(f.forks(), 1);
  const task = execution.tasks.get(job.id);
  Object.assign(task, agentValue(task));
  await assert.rejects(f.advance(job.id, 'agents'), /publication unconfirmed/);
  const post = () => new Request(task.remote + '/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: push('refs/heads/feature', 'b'.repeat(40), 'c'.repeat(40)) });
  assert.equal((await agentGit(f.env, job.id, post(), 'publish', f.env.workflow, f.providerFetch)).status, 200);
  assert.equal((await agentGit(f.env, job.id, post(), 'publish', f.env.workflow, f.providerFetch)).status, 403);
  assert.equal(f.tokens.size, 0);
  await f.advance(job.id, 'agents'); await f.advance(job.id, 'store');
  const downloaded = await value(await f.read(job.id, 'report', readerToken));
  assert.equal(downloaded.report.agentResult.proposalOnly, true); assert.equal(downloaded.report.agentResult.tests.exitCode, 1);
  assert.equal(downloaded.report.agentResult.proposalCommitId, 'c'.repeat(40)); assert.equal(downloaded.report.agent.prompt, 'Improve the approved source.');
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending, null);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.equal((await value(await f.read(job.id, 'report'))).job.stale, true);
  await value(await f.call('', { ...f.grant, role: 'none' }, ownerToken, '/native/repository-grant'));
  assert.equal((await f.read(job.id, 'report', readerToken)).status, 404);
});

test('native agent cancellation and policy changes fence further Git and dispatch', async t => {
  const f = await evidenceFixture(t), execution = allocateAgents(f);
  const job = (await value(await f.evidence({ ...f.input, advice: false, agent: { prompt: 'Improve the approved source.' } }))).job;
  await f.advance(job.id, 'agents');
  await value(await f.read(job.id, 'cancel'));
  assert.equal(execution.tasks.get(job.id).state, 'cancelled');
  const request = new Request(execution.tasks.get(job.id).remote + '/info/refs?service=git-upload-pack');
  assert.equal((await agentGit(f.env, job.id, request, 'clone', f.env.workflow, f.providerFetch)).status, 403);
  const next = (await value(await f.evidence({ ...f.input, idempotencyKey: nonce(), advice: false, agent: { prompt: 'Second task.' } }))).job;
  f.env.AGENT_POLICY_SHA256 = 'e'.repeat(64);
  assert.equal((await f.advance(next.id, 'agents')).state, 'REFUSED'); assert.equal(execution.admissions(), 1);
});

test('test and agent tasks share the same workspace concurrency allocation', async t => {
  const f = await evidenceFixture(t), execution = allocateAgents(f); f.env.EVIDENCE_DAILY_LIMIT = '3';
  const one = (await value(await f.evidence({ ...f.input, advice: false, runTests: true }))).job;
  await f.advance(one.id, 'tests');
  const two = (await value(await f.evidence({ ...f.input, advice: false, idempotencyKey: nonce(), agent: { prompt: 'Second slot.' } }))).job;
  await f.advance(two.id, 'agents');
  const three = (await value(await f.evidence({ ...f.input, advice: false, idempotencyKey: nonce(), agent: { prompt: 'Third slot.' } }))).job;
  assert.equal((await f.advance(three.id, 'agents')).state, 'REFUSED'); assert.equal(execution.admissions(), 1);
});


test('native agent publication uncertainty fences another write, and original-writer revocation stops work', async t => {
  const f = await evidenceFixture(t), execution = allocateAgents(f);
  await value(await f.call('', { ...f.grant, role: 'write' }, ownerToken, '/native/repository-grant'));
  const job = (await value(await f.evidence({ ...f.input, advice: false, agent: { prompt: 'Writer-owned proposal.' } }, readerToken))).job;
  await f.advance(job.id, 'agents');
  const task = execution.tasks.get(job.id);
  const post = () => new Request(task.remote + '/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: push('refs/heads/feature', 'b'.repeat(40), 'c'.repeat(40)) });
  f.losePush(); await assert.rejects(agentGit(f.env, job.id, post(), 'publish', f.env.workflow, f.providerFetch));
  assert.equal(f.sql.prepare('SELECT agent_publish FROM evidence_jobs').get().agent_publish, 'DISPATCHED');
  assert.equal((await agentGit(f.env, job.id, post(), 'publish', f.env.workflow, f.providerFetch)).status, 403);
  assert.equal(f.tokens.size, 0);
  await value(await f.call('', { ...f.grant, role: 'none' }, ownerToken, '/native/repository-grant'));
  assert.equal((await f.advance(job.id, 'authorize-agent')).state, 'REFUSED');
  assert.equal((await agentGit(f.env, job.id, new Request(task.remote + '/info/refs?service=git-upload-pack'), 'clone', f.env.workflow, f.providerFetch)).status, 403);
});


test('an existing fork target or unconfirmed absence never dispatches an agent fork', async t => {
  const f = await evidenceFixture(t); allocateAgents(f);
  const job = (await value(await f.evidence({ ...f.input, advice: false, agent: { prompt: 'Improve source.' } }))).job;
  const get = f.env.ARTIFACTS.get, name = 'repo-' + job.id.replaceAll('-', '');
  f.env.ARTIFACTS.get = async target => target === name ? { info: async () => ({ name }), [Symbol.dispose]() {} } : get(target);
  await assert.rejects(f.advance(job.id, 'agents'), /already exists/); assert.equal(f.forks(), 0);
  f.env.ARTIFACTS.get = async target => { if (target === name) throw Error('Provider unavailable'); return get(target); };
  await assert.rejects(f.advance(job.id, 'agents'), /Provider unavailable/); assert.equal(f.forks(), 0);
  assert.equal(f.sql.prepare('SELECT agent_state FROM evidence_jobs').get().agent_state, 'REQUESTED');
});


test('failed workflows durably refuse further execution without rewriting completed evidence', async t => {
  const f = await evidenceFixture(t); allocateAgents(f);
  const job = (await value(await f.evidence({ ...f.input, advice: false, agent: { prompt: 'Improve source.' } }))).job;
  await f.advance(job.id, 'agents');
  assert.equal((await f.advance(job.id, 'refuse')).state, 'REFUSED');
  assert.equal((await f.advance(job.id, 'authorize-agent')).state, 'REFUSED');
  await value(await f.read(job.id, 'cancel'));
  const next = (await value(await f.evidence({ ...f.input, idempotencyKey: nonce(), advice: false }))).job;
  await f.advance(next.id, 'store');
  assert.equal((await f.advance(next.id, 'refuse')).state, 'SUCCEEDED');
  assert.equal((await f.read(next.id, 'report')).status, 200);
});

async function deliveryFixture(t) {
  const f = await evidenceFixture(t), execution = allocateTests(f);
  f.sql.prepare("UPDATE users SET email=CASE id WHEN 1 THEN 'alice@example.com' ELSE 'bob@example.com' END").run();
  Object.assign(f.env, { PREVIEW_ORIGIN: 'https://preview.example.net', PREVIEW_ACCESS_AUD: 'preview-aud', PREVIEW_PATH: 'public', PREVIEW_TTL: '900' });
  const get = f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get = async name => {
    const repo = await get(name), readTree = repo.readTree, readBlob = repo.readBlob;
    repo.readTree = async hash => hash === 'f'.repeat(40) ? [...await readTree(hash), { name: 'public', hash: '4'.repeat(40), type: 'tree', mode: '40000' }] : hash === '4'.repeat(40) ? [{ name: 'index.html', hash: '5'.repeat(40), type: 'blob', mode: '100644' }] : null;
    repo.readBlob = async hash => hash === '5'.repeat(40) ? new Blob(['<h1>private canonical preview</h1>']) : readBlob(hash);
    return repo;
  };
  f.env.EVIDENCE_BUCKET.head = async key => f.objects.has(key) ? {} : null;
  f.env.EVIDENCE_BUCKET.delete = async key => { f.objects.delete(key); };
  const job = (await value(await f.evidence({ ...f.input, advice: false, runTests: true }))).job;
  await f.advance(job.id, 'tests');
  Object.assign(execution.tasks.get(job.id), { state: 'PASSED', cleanup: 'destroyed', exitCode: 0, stdout: '', stderr: 'OK', finishedAt: Date.now() });
  await f.advance(job.id, 'tests');
  await f.advance(job.id, 'store');
  const preview = (body, token = ownerToken) => f.call('', { repository: key, repositoryId: '1', ...body }, token, '/native/pr-preview');
  return { ...f, job, preview, publication: { action: 'create', jobId: job.id, idempotencyKey: nonce() }, broker: input => servePreview(f.env, input) };
}

test('native read routes preserve current evidence and access while rejecting every mutation action', async t => {
  const f = await deliveryFixture(t);
  const context = { repository: key, repositoryId: '1', number: 1, jobId: f.job.id };
  const read = (path, body, token = ownerToken) => f.call('', { ...context, ...body }, token, '/native/' + path + '/read');
  for (const action of ['list', 'status', 'report']) {
    assert.deepEqual(await value(await read('pr-evidence', { action })), await value(await f.evidence({ ...context, action })));
  }
  assert.deepEqual(await value(await read('pr-preview', { action: 'list' })), await value(await f.preview({ action: 'list' })));
  const original = f.sql.prepare('SELECT * FROM evidence_jobs').all();
  for (const action of ['create','cancel','grant','revoke','capture','renew','unknown',undefined]) {
    assert.equal((await read('pr-evidence', { ...f.input, action })).status, 400);
    assert.equal((await read('pr-preview', { ...f.publication, action })).status, 400);
  }
  assert.deepEqual(f.sql.prepare('SELECT * FROM evidence_jobs').all(), original);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM previews').get().n, 0);
  assert.equal((await read('pr-evidence', { action: 'compare', jobIds: [f.job.id,f.job.id] })).status, 400);
  for (const path of ['pr-evidence','pr-preview']) {
    assert.equal((await read(path, { action: 'list', repositoryId: '2' })).status, 404);
    assert.equal((await read(path, { action: 'list' }, 'invalid')).status, 401);
  }
  f.sql.prepare('DELETE FROM grants WHERE user_id=1').run();
  for (const path of ['pr-evidence','pr-preview']) assert.equal((await read(path, { action: 'list' })).status, 404);
});

test('tested native preview publication is immutable, replay-bound and private to current repository readers', async t => {
  const f = await deliveryFixture(t);
  const published = [];
  f.env.EVIDENCE_DAILY_LIMIT = '40';
  f.env.previewChanged = id => {
    assert.equal(f.sql.prepare('SELECT state FROM previews WHERE repository_id=?').get(id).state, 'READY');
    published.push(String(id));
  };
  assert.equal((await f.preview(f.publication, readerToken)).status, 404);
  const preview = (await value(await f.preview(f.publication))).preview;
  assert.equal(preview.state, 'READY'); assert.equal(preview.commitId, f.selection.headCommitId);
  assert.equal((await value(await f.preview(f.publication))).preview.id, preview.id);
  assert.deepEqual(published, ['1']);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM previews').get().n, 1);
  assert.equal((await f.preview({ ...f.publication, jobId: nonce() })).status, 409);
  const { grant } = await value(await f.preview({ action: 'grant', previewId: preview.id }, readerToken));
  const auth = { previewId: preview.id, email: 'bob@example.com', method: 'POST', path: '__golf/auth', origin: f.env.PUBLIC_ORIGIN, grant };
  await assert.rejects(f.broker({ ...auth, email: 'alice@example.com' }), /unavailable/);
  await assert.rejects(f.broker({ ...auth, origin: f.env.PREVIEW_ORIGIN }), /unavailable/);
  const { session } = await f.broker(auth);
  await assert.rejects(f.broker(auth), /unavailable/);
  const input = { previewId: preview.id, email: 'bob@example.com', method: 'GET', path: '', credential: session };
  assert.equal((await f.broker(input)).content, '<h1>private canonical preview</h1>');
  assert.equal((await f.broker({ ...input, method: 'HEAD' })).content, null);
  assert.equal([...f.objects.keys()].filter(k => k.startsWith('native-previews/')).length, 1);
  await value(await f.call('', { ...f.grant, role: 'none' }, ownerToken, '/native/repository-grant'));
  await assert.rejects(f.broker(input), /unavailable/);
  assert.equal((await f.preview({ action: 'list' }, readerToken)).status, 404);
});

test('scanned image preview serves matching OCI assets and revokes access when registry policy changes', async t => {
  const f = await deliveryFixture(t), imageDigest = 'sha256:' + 'a'.repeat(64);
  const job = f.sql.prepare('SELECT report_key FROM evidence_jobs WHERE id=?').get(f.job.id);
  const report = JSON.parse(f.objects.get(job.report_key));
  report.tests.image = { registry: 'https://registry.example.com', repository: 'alice/project', tag: 'ci-' + f.job.id,
    digest: imageDigest, commitId: f.selection.headCommitId };
  const data = JSON.stringify(report);
  f.objects.set(job.report_key, data);
  f.sql.prepare('UPDATE evidence_jobs SET report_hash=?,report_bytes=? WHERE id=?').run(await digest(data), Buffer.byteLength(data), f.job.id);
  f.env.REGISTRY_ORIGIN = report.tests.image.registry;
  let allowed = false, content = '<h1>private canonical preview</h1>';
  f.env.REGISTRY = { async manage(input) {
    assert.equal(input.binding.name, report.tests.image.repository);
    assert.equal(input.reference, imageDigest);
    if (input.action === 'policy') return { digest: imageDigest, allowed };
    assert.equal(input.action, 'downloadImageConfig');
    const bundle = { schema: 'golf.native.static-preview.v1', commitId: f.selection.headCommitId,
      treeId: 'f'.repeat(40), sourcePath: 'public', files: [{ path: 'index.html', contentType: 'text/html; charset=utf-8', content }] };
    const bytes = Buffer.from(JSON.stringify({ config: { Labels: { 'org.opencontainers.image.revision': f.selection.headCommitId,
      'dev.golf.static-preview.v1': JSON.stringify(bundle) } } }));
    return { subject: imageDigest, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
  } };
  const input = { ...f.publication, kind: 'IMAGE_STATIC', imageDigest };
  assert.equal((await f.preview(input)).status, 412);
  allowed = true; content = '<h1>different image content</h1>';
  assert.equal((await f.preview(input)).status, 412);
  content = '<h1>private canonical preview</h1>';
  const preview = (await value(await f.preview(input))).preview;
  assert.equal(preview.kind, 'IMAGE_STATIC'); assert.equal(preview.imageDigest, imageDigest);
  const { grant } = await value(await f.preview({ action: 'grant', previewId: preview.id }));
  const { session } = await f.broker({ previewId: preview.id, email: 'alice@example.com', method: 'POST', path: '__golf/auth', origin: f.env.PUBLIC_ORIGIN, grant });
  const request = { previewId: preview.id, email: 'alice@example.com', method: 'GET', path: '', credential: session };
  assert.equal((await f.broker(request)).content, content);
  allowed = false;
  await assert.rejects(f.broker(request), /unavailable/);
  assert.equal((await f.preview({ action: 'grant', previewId: preview.id })).status, 404);
});

test('preview lifetime, session expiry, PR changes and inactive identities fail closed', async t => {
  const f = await deliveryFixture(t), preview = (await value(await f.preview(f.publication))).preview;
  const { grant } = await value(await f.preview({ action: 'grant', previewId: preview.id }, readerToken));
  const { session } = await f.broker({ previewId: preview.id, email: 'bob@example.com', method: 'POST', path: '__golf/auth', origin: f.env.PUBLIC_ORIGIN, grant });
  const input = { previewId: preview.id, email: 'bob@example.com', method: 'GET', path: '', credential: session };
  f.sql.prepare('UPDATE users SET active=0 WHERE id=2').run(); await assert.rejects(f.broker(input), /unavailable/); f.sql.prepare('UPDATE users SET active=1 WHERE id=2').run();
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]); await assert.rejects(f.broker(input), /unavailable/);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'b'.repeat(40)]]);
  f.sql.prepare("UPDATE discussions SET state='CLOSED',revision=revision+1 WHERE kind='pull'").run(); await assert.rejects(f.broker(input), /unavailable/);
  f.sql.prepare("UPDATE discussions SET state='OPEN',revision=revision-1 WHERE kind='pull'").run();
  f.sql.prepare("UPDATE preview_credentials SET expires_at='2000-01-01' WHERE kind='session'").run(); await assert.rejects(f.broker(input), /unavailable/);
  f.sql.prepare("UPDATE previews SET expires_at='2000-01-01'").run();
  assert.equal((await f.preview({ action: 'grant', previewId: preview.id })).status, 404);
  const cleanup = await cleanupPreviews(f.env); assert.equal(cleanup.purged, 1);
  assert.equal(f.sql.prepare('SELECT state,purged FROM previews').get().state, 'EXPIRED');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM preview_credentials').get().n, 0);
  assert.equal([...f.objects.keys()].filter(k => k.startsWith('native-previews/')).length, 0);
  assert.equal((await cleanupPreviews(f.env)).purged, 0);
});

test('lost preview PUT responses never rebuild or republish, while revocation purges the original object', async t => {
  const f = await deliveryFixture(t), put = f.env.EVIDENCE_BUCKET.put;
  f.env.EVIDENCE_BUCKET.put = async (...args) => { await put(...args); throw Error('Lost preview acknowledgement'); };
  assert.equal((await f.preview(f.publication)).status, 503);
  const saved = (await value(await f.preview(f.publication))).preview;
  assert.equal(saved.state, 'PUBLISHING'); assert.equal(f.sql.prepare('SELECT count(*) AS n FROM previews').get().n, 1);
  assert.equal((await f.preview({ action: 'grant', previewId: saved.id })).status, 404);
  const revoked = await value(await f.preview({ action: 'revoke', previewId: saved.id }));
  assert.equal(revoked.preview.state, 'REVOKED'); assert.equal(revoked.preview.purged, true);
  assert.equal([...f.objects.keys()].filter(k => k.startsWith('native-previews/')).length, 0);
});

test('preview storage read rechecks repository access and does not serve corrupt bytes', async t => {
  const f = await deliveryFixture(t), preview = (await value(await f.preview(f.publication))).preview;
  const { grant } = await value(await f.preview({ action: 'grant', previewId: preview.id }, readerToken));
  const { session } = await f.broker({ previewId: preview.id, email: 'bob@example.com', method: 'POST', path: '__golf/auth', origin: f.env.PUBLIC_ORIGIN, grant });
  const input = { previewId: preview.id, email: 'bob@example.com', method: 'GET', path: '', credential: session };
  const key = [...f.objects.keys()].find(k => k.startsWith('native-previews/')), original = f.objects.get(key);
  f.objects.set(key, original.replace('private', 'leaked!'));
  await assert.rejects(f.broker(input), /changed/); f.objects.set(key, original);
  const get = f.env.EVIDENCE_BUCKET.get;
  f.env.EVIDENCE_BUCKET.get = async key => { const value = await get(key); f.sql.prepare('DELETE FROM grants WHERE user_id=2').run(); return value; };
  await assert.rejects(f.broker(input), /unavailable/);
});

test('preview publication rejects failed tests, changed policy and namespace exhaustion', async t => {
  const f = await deliveryFixture(t);
  f.env.EVIDENCE_DAILY_LIMIT = '20';
  const execution = allocateTests(f);
  const failed = (await value(await f.evidence({ ...f.input, idempotencyKey: nonce(), advice: false, runTests: true }))).job;
  await f.advance(failed.id, 'tests');
  Object.assign(execution.tasks.get(failed.id), { state: 'FAILED', cleanup: 'destroyed', exitCode: 1, stdout: '', stderr: 'FAIL', finishedAt: Date.now() });
  await f.advance(failed.id, 'tests'); await f.advance(failed.id, 'store');
  assert.equal((await f.preview({ ...f.publication, jobId: failed.id })).status, 412);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM previews').get().n, 0);
  f.env.TEST_POLICY_SHA256 = 'd'.repeat(64); assert.equal((await f.preview(f.publication)).status, 412); f.env.TEST_POLICY_SHA256 = 'e'.repeat(64);
  f.env.TEST_EXECUTION_ENABLED = 'false'; assert.equal((await f.preview(f.publication)).status, 412); f.env.TEST_EXECUTION_ENABLED = 'true';
  for (let i = 0; i < 4; i++) assert.equal((await f.preview({ ...f.publication, idempotencyKey: nonce() })).status, 200);
  assert.equal((await f.preview({ ...f.publication, idempotencyKey: nonce() })).status, 429);
  assert.equal((await f.preview(f.publication)).status, 429); // Exhausted key never reserves another publication.
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM previews').get().n, 4);
  for (const { id } of f.sql.prepare('SELECT id FROM previews').all()) await value(await f.preview({ action: 'revoke', previewId: id }));
  f.env.EVIDENCE_DAILY_LIMIT = '4';
  assert.equal((await f.preview({ ...f.publication, idempotencyKey: nonce() })).status, 429);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM previews WHERE purged=0').get().n, 0);
});

test('approved static source rejects symlinks, hidden paths, unsupported binaries and oversized trees', async () => {
  const entry = { name: 'index.html', hash: 'a'.repeat(40), type: 'blob', mode: '100644' };
  let items = [entry];
  const repo = { async readCommit() { return { treeHash: 'f'.repeat(40) }; }, async readTree(hash) { return hash === 'f'.repeat(40) ? [{ name: 'public', hash: 'e'.repeat(40), type: 'tree' }] : items; }, async readBlob() { return new Blob(['<h1>safe</h1>']); } };
  assert.equal((await previewBundle(repo, commit, 'public')).files.length, 1);
  for (const change of [{ type: 'symlink', mode: '120000' }, { name: '.env' }, { name: 'index.png' }, { name: 'a/../index.html' }, { mode: '100755' }]) {
    items = [{ ...entry, ...change }]; await assert.rejects(previewBundle(repo, commit, 'public'));
  }
  items = Array.from({ length: 65 }, () => entry); await assert.rejects(previewBundle(repo, commit, 'public'));
});

test('automatic preview follows passing canonical tests once and keeps evidence successful when delivery is refused', async t => {
  const f = await deliveryFixture(t); f.env.PREVIEW_AUTO = 'true';
  assert.equal((await f.advance(f.job.id, 'store')).preview, undefined);
  const result = await f.advance(f.job.id, 'publish-static'); assert.equal(result.preview.state, 'READY');
  assert.equal((await f.advance(f.job.id, 'publish-static')).preview.id, result.preview.id);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM previews').get().n, 1);
  f.env.PREVIEW_PATH = 'missing';
  const refused = await f.advance(f.job.id, 'publish-static'); assert.equal(refused.state, 'SUCCEEDED'); assert.equal(refused.preview.state, 'REFUSED');
  assert.equal(f.sql.prepare('SELECT state FROM evidence_jobs WHERE id=?').get(f.job.id).state, 'SUCCEEDED');
});

test('automatic app publication has a separate phase and replays only its original resource identities', async t => {
  const f = await deliveryFixture(t), apps = allocateApps(f); f.env.APP_AUTO = 'true';
  assert.equal((await f.advance(f.job.id, 'store')).app, undefined);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM previews').get().n, 0);
  const published = await f.advance(f.job.id, 'publish-app'); assert.equal(published.app.state, 'READY');
  const effects = apps.effects.length;
  assert.equal((await f.advance(f.job.id, 'publish-app')).app.id, published.app.id);
  assert.equal(apps.effects.length, effects);
  f.sql.prepare('DELETE FROM grants WHERE user_id=1').run();
  assert.equal((await f.advance(f.job.id, 'publish-app')).app, undefined);
  assert.equal(apps.effects.length, effects);
});

test('native proposal comparison checks current readers, exact source and human conflict resolution', async t => {
  const f = await evidenceFixture(t), execution = allocateAgents(f), jobs = [];
  for (const prompt of ['First approach', 'Second approach']) {
    const job = (await value(await f.evidence({ ...f.input, advice: false, idempotencyKey: nonce(), agent: { prompt } }))).job;
    await f.advance(job.id, 'agents');
    const task = execution.tasks.get(job.id); Object.assign(task, { ...agentValue(task), patch: prompt });
    await agentGit(f.env, job.id, new Request(task.remote + '/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: push('refs/heads/feature', 'b'.repeat(40), 'c'.repeat(40)) }), 'publish', f.env.workflow, f.providerFetch);
    await f.advance(job.id, 'agents'); await f.advance(job.id, 'store'); jobs.push(job);
  }
  const input = { action: 'compare', repository: key, repositoryId: '1', jobIds: jobs.map(j => j.id) };
  const compared = await value(await f.evidence(input, readerToken));
  assert.equal(compared.resolution, 'REQUIRES_HUMAN_RESOLUTION'); assert.equal(compared.proposals.length, 2); assert.equal(compared.advisoryOnly, true);
  const readCompare = () => f.call('', input, readerToken, '/native/pr-evidence/read');
  assert.deepEqual(await value(await readCompare()), compared);
  assert.equal((await f.evidence({ ...input, jobIds: [jobs[0].id, jobs[0].id] })).status, 400);
  const listed = await value(await f.evidence({ action: 'list', repository: key, repositoryId: '1', number: f.selection.number }, readerToken));
  assert.equal(listed.jobs.length, 2); assert.equal(listed.jobs.some(j => j.prompt || j.patch), false);
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.equal((await f.evidence(input)).status, 412);
  assert.equal((await readCompare()).status, 412);
  await value(await f.call('', { ...f.grant, role: 'none' }, ownerToken, '/native/repository-grant'));
  assert.equal((await f.evidence(input, readerToken)).status, 404);
  assert.equal((await readCompare()).status, 404);
});

test('Browser Run snapshot is once-only, bound to private immutable assets and removed on revocation', async t => {
  const f = await deliveryFixture(t), preview = (await value(await f.preview(f.publication))).preview;
  const png = new Uint8Array(24); png.set([137, 80, 78, 71, 13, 10, 26, 10]); let calls = 0;
  f.env.PREVIEW_BROWSER = 'true'; f.env.BROWSER = { async quickAction(action, options) {
    calls++; assert.equal(action, 'screenshot'); assert.equal(options.html, '<h1>private canonical preview</h1>');
    assert.equal(options.setJavaScriptEnabled, false); assert.deepEqual(options.rejectRequestPattern, ['.*']); assert.equal(options.cacheTTL, 0);
    assert.equal(JSON.stringify(options).includes(ownerToken), false); assert.equal(options.url, undefined);
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'X-Browser-Ms-Used': '234' } });
  } };
  const get = f.env.EVIDENCE_BUCKET.get, put = f.env.EVIDENCE_BUCKET.put;
  f.env.EVIDENCE_BUCKET.put = async (key, value, options) => value instanceof Uint8Array ? (f.objects.set(key, value), {}) : put(key, value, options);
  f.env.EVIDENCE_BUCKET.get = async key => key.endsWith('snapshot.png') && f.objects.has(key) ? { size: f.objects.get(key).byteLength, async arrayBuffer() { return f.objects.get(key).buffer; } } : get(key);
  assert.equal((await f.preview({ action: 'capture', previewId: preview.id }, readerToken)).status, 404);
  const captured = (await value(await f.preview({ action: 'capture', previewId: preview.id }))).preview;
  assert.equal(captured.captureState, 'READY'); assert.equal(captured.browserMs, 234);
  assert.equal((await value(await f.preview({ action: 'capture', previewId: preview.id }))).preview.captureState, 'READY'); assert.equal(calls, 1);
  const image = await f.preview({ action: 'screenshot', previewId: preview.id }, readerToken);
  assert.equal(image.status, 200); assert.equal(image.headers.get('Content-Type'), 'image/png'); assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  await value(await f.preview({ action: 'revoke', previewId: preview.id }));
  assert.equal([...f.objects.keys()].filter(k => k.startsWith('native-previews/')).length, 0);
  assert.equal((await f.preview({ action: 'screenshot', previewId: preview.id }, readerToken)).status, 404);
});

test('ambiguous Browser Run responses retain uncertainty without another paid dispatch', async t => {
  const f = await deliveryFixture(t), preview = (await value(await f.preview(f.publication))).preview; let calls = 0;
  f.env.PREVIEW_BROWSER = 'true'; f.env.BROWSER = { async quickAction() { calls++; throw Error('Lost browser response'); } };
  assert.equal((await value(await f.preview({ action: 'capture', previewId: preview.id }))).preview.captureState, 'UNKNOWN');
  assert.equal((await value(await f.preview({ action: 'capture', previewId: preview.id }))).preview.captureState, 'UNKNOWN'); assert.equal(calls, 1);
  assert.equal((await f.preview({ action: 'screenshot', previewId: preview.id })).status, 404);
});

test('Worker app admission provisions isolated bindings and hostname, forwards no credentials, and retires owned data', async t => {
  const f = await deliveryFixture(t), apps = allocateApps(f), publication = { ...f.publication, kind: 'WORKER' };
  assert.equal((await f.preview(publication, readerToken)).status, 404);
  const preview = (await value(await f.preview(publication))).preview;
  assert.equal(preview.kind, 'WORKER'); assert.equal(preview.state, 'READY');
  assert.equal(new URL(preview.url).hostname, preview.id + '.preview.example.net');
  assert.equal((await value(await f.preview(publication))).preview.id, preview.id);
  assert.equal(apps.effects.filter(([method, path]) => method === 'POST' && path === '/d1/database').length, 1);
  const script = [...apps.uploads.values()].find(u => u.bindings.some(b => b.name === 'DB'));
  assert.equal(script.bindings.length, 4); assert.ok(script.bindings.find(b => b.type === 'secrets_store_secret'));
  const { grant, action } = await value(await f.preview({ action: 'grant', previewId: preview.id }, readerToken));
  assert.equal(action, preview.url + '__golf/auth');
  const auth = { app: true, url: action, previewId: preview.id, email: 'bob@example.com', method: 'POST', path: '__golf/auth', origin: f.env.PUBLIC_ORIGIN, grant };
  const { session } = await f.broker(auth); await assert.rejects(f.broker(auth), /unavailable/);
  const input = { app: true, url: preview.url + 'api?view=all', previewId: preview.id, email: 'bob@example.com', method: 'GET', path: 'api', credential: session,
    headers: { Accept: 'application/json', Cookie: 'private', Authorization: 'private', 'Cf-Access-Jwt-Assertion': 'private' } };
  const response = await f.broker(input); assert.equal(response.app, true);
  assert.equal(JSON.parse(new TextDecoder().decode(response.content)).query, '?view=all');
  await assert.rejects(f.broker({ ...input, method: 'POST', origin: 'https://evil.example' }), /unavailable/);
  apps.during(async () => { f.sql.prepare('DELETE FROM grants WHERE repository_id=1 AND user_id=2').run(); });
  await assert.rejects(f.broker(input), /unavailable/);
  assert.equal((await f.preview({ action: 'capture', previewId: preview.id })).status, 400);
  const revoked = (await value(await f.preview({ action: 'revoke', previewId: preview.id }))).preview;
  assert.equal(revoked.purged, true); assert.equal(apps.values.size, 0);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM app_resources WHERE state<>'DELETED'").get().n, 0);
});

test('uncertain app allocation is fenced, never duplicated, and never adopted for deletion', async t => {
  const f = await deliveryFixture(t), apps = allocateApps(f), publication = { ...f.publication, kind: 'WORKER' };
  apps.lose('/d1/database');
  const failed = await f.preview(publication); assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes('private_management_token'), false);
  const preview = (await value(await f.preview(publication))).preview;
  assert.equal(preview.state, 'PUBLISHING'); assert.equal(apps.effects.length, 1);
  assert.equal((await f.preview({ action: 'grant', previewId: preview.id })).status, 404);
  assert.equal((await f.preview({ action: 'revoke', previewId: preview.id })).status, 503);
  assert.equal(f.sql.prepare('SELECT state,purged FROM previews').get().state, 'REVOKED');
  assert.deepEqual(await cleanupPreviews(f.env), { purged: 0, pending: 1 });
  assert.equal(apps.effects.length, 1); assert.equal(apps.values.size, 1);
});

test('app policy changes and replaced provider identities prevent unsafe reads and cleanup', async t => {
  const f = await deliveryFixture(t), apps = allocateApps(f);
  const preview = (await value(await f.preview({ ...f.publication, kind: 'WORKER' }))).preview;
  f.env.APP_POLICY = JSON.stringify({ ...apps.policy, entry: 'different.mjs' });
  assert.equal((await f.preview({ action: 'grant', previewId: preview.id })).status, 404);
  assert.equal((await f.preview({ action: 'revoke', previewId: preview.id })).status, 503);
  assert.equal(apps.effects.filter(([method]) => method === 'DELETE').length, 0);
  f.env.APP_POLICY = JSON.stringify(apps.policy);
  const domain = [...apps.values].find(([path]) => path.startsWith('/workers/domains/'));
  domain[1].service = 'someone-else';
  assert.deepEqual(await cleanupPreviews(f.env), { purged: 0, pending: 1 });
  assert.equal(apps.effects.filter(([method]) => method === 'DELETE').length, 0);
});

test('automatic CI uses only confirmed pushes, current writers, stable admission keys and original source', async t => {
  const f = await evidenceFixture(t); allocateTests(f); f.env.CI_AUTO = 'true';
  const add = (state, ci, next = 'b'.repeat(40)) => f.sql.prepare('INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,ci_state,created_at) VALUES(?,1,1,?,?,?,?,?,?)')
    .run(nonce(), 'refs/heads/feature', commit, next, state, ci, new Date().toISOString());
  add('DISPATCHED', 'NONE'); assert.deepEqual(await runCI(f.env), { admitted: 0 }); assert.equal(f.messages.length, 0);
  add('APPLIED', 'PENDING'); assert.deepEqual(await runCI(f.env), { admitted: 1 }); assert.equal(f.messages.length, 1);
  assert.deepEqual(await runCI(f.env), { admitted: 0 }); assert.equal(f.messages.length, 1);
  const job = f.sql.prepare('SELECT * FROM evidence_jobs').get(); assert.equal(JSON.parse(job.snapshot).execution.commitId, 'b'.repeat(40));
  add('APPLIED', 'PENDING', 'c'.repeat(40)); assert.deepEqual(await runCI(f.env), { admitted: 0 }); assert.equal(f.messages.length, 1);
  add('APPLIED', 'PENDING'); f.sql.prepare('DELETE FROM grants WHERE repository_id=1 AND user_id=1').run();
  assert.deepEqual(await runCI(f.env), { admitted: 0 }); assert.equal(f.messages.length, 1);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM git_operations WHERE ci_state='REFUSED'").get().n, 1);
});

test('app request budget reserves before dispatch, expiry denies immediately, and cleanup continues past an uncertain peer', async t => {
  const f = await deliveryFixture(t), apps = allocateApps(f);
  const preview = (await value(await f.preview({ ...f.publication, kind: 'WORKER' }))).preview;
  const grant = await value(await f.preview({ action: 'grant', previewId: preview.id }, readerToken));
  const auth = { app: true, url: grant.action, previewId: preview.id, email: 'bob@example.com', method: 'POST', path: '__golf/auth', origin: f.env.PUBLIC_ORIGIN, grant: grant.grant };
  const { session } = await f.broker(auth);
  const input = { app: true, url: preview.url, previewId: preview.id, email: 'bob@example.com', method: 'GET', path: '', credential: session };
  const day = new Date().toISOString().slice(0, 10);
  f.sql.prepare('INSERT INTO app_requests(day,total) VALUES(?,1999)').run(day);
  let calls = 0; apps.during(async () => { calls++; assert.equal(f.sql.prepare('SELECT total FROM app_requests WHERE day=?').get(day).total, 2000); });
  await f.broker(input); assert.equal(calls, 1);
  await assert.rejects(f.broker(input), /daily application request allocation/); assert.equal(calls, 1);
  const other = { ...f.publication, kind: 'WORKER', idempotencyKey: nonce() };
  apps.lose('/d1/database'); assert.equal((await f.preview(other)).status, 503);
  f.sql.prepare("UPDATE previews SET expires_at='2000-01-01'").run();
  await assert.rejects(f.broker(input), /unavailable/);
  assert.deepEqual(await cleanupPreviews(f.env), { purged: 1, pending: 1 });
  assert.equal(f.sql.prepare('SELECT purged FROM previews WHERE id=?').get(preview.id).purged, 1);
});

test('native runtime reports its separate settings contract and unavailable adapters explicitly', async t => {
  const f = await fixture(t);
  const config = await value(await f.call('', {}, ownerToken, '/native/config'));
  assert.equal(config.runtimeProfile, 'cloudflare-native'); assert.equal(config.apps, false); assert.equal(config.automaticCI, false);
  const capabilities = await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'));
  assert.equal(capabilities.runtimeProfile, 'cloudflare-native');
  for (const id of ['settings.infrastructure', 'settings.runners', 'settings.local-auth', 'settings.notifications', 'settings.cloudflare-resources', 'native-pr-apps']) {
    assert.equal(capabilities.capabilities.find(c => c.id === id).state, 'CAPABILITY_STATE_DISABLED');
  }
  assert.equal(capabilities.capabilities.find(c => c.id === 'settings.native').state, 'CAPABILITY_STATE_READY');
  const allocated = await deliveryFixture(t);
  allocateApps(allocated);
  const configured = await value(await allocated.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'));
  assert.equal(configured.capabilities.find(c => c.id === 'native-pr-apps').state, 'CAPABILITY_STATE_DEGRADED');
});

test('shared source UI commit reads bind immutable identity and current repository grants', async t => {
  const f = await fixture(t); const created = await (await f.create()).json(); await f.sendPush();
  const body = { repository: { owner: 'alice', name: 'project' }, repositoryId: created.repository.id, ref: commit, page: { limit: 1 } };
  const result = await (await f.call('ListCommits', body)).json();
  assert.equal(result.repositoryId, created.repository.id); assert.equal(result.commitId, commit); assert.equal(result.commits[0].sha, commit);
  assert.equal(result.commits[0].authorName, 'Alice'); assert.equal(result.commits[0].authoredAt, '2023-11-14T22:13:20.000Z');
  assert.equal((await f.call('ListCommits', { ...body, ref: 'main' })).status, 400);
  assert.equal((await f.call('ListCommits', { ...body, repositoryId: '999' })).status, 404);
  const path = await (await f.call('ListCommits', { ...body, path: 'hello.txt' })).json(); assert.equal(path.path, 'hello.txt'); assert.equal(path.commits[0].sha, commit);
  assert.equal((await f.call('ListCommits', { ...body, path: '../secret' })).status, 400);
  assert.equal((await f.call('ListCommits', body, readerToken)).status, 404);
  f.sql.prepare("INSERT INTO grants(repository_id,user_id,role) VALUES(?,2,'read')").run(created.repository.id);
  assert.equal((await f.call('ListCommits', body, readerToken)).status, 200);
  f.sql.prepare('DELETE FROM grants WHERE user_id=2').run(); assert.equal((await f.call('ListCommits', body, readerToken)).status, 404);
});

test('shared readable source routes retain ref ambiguity, lightweight tags and literal paths', async t => {
  const f = await fixture(t); const created = await (await f.create()).json(); await f.sendPush();
  f.setRefs([['refs/heads/main',commit],['refs/heads/main/path','b'.repeat(40)],['refs/tags/v1',commit]]);
  const body = { repository: {owner:'alice',name:'project'}, repositoryId:created.repository.id };
  const ambiguous = await (await f.call('ResolveRepositorySource', {...body,suffix:'main/path/hello.txt'})).json();
  assert.equal(ambiguous.resolution,'REPOSITORY_SOURCE_RESOLUTION_AMBIGUOUS'); assert.equal(ambiguous.candidates.length,2);
  const tag = await (await f.call('ResolveRepositorySource', {...body,selector:{kind:'REPOSITORY_SOURCE_REF_KIND_TAG',name:'v1'}})).json();
  assert.equal(tag.selection.tagObjectId,commit);
  const exact = await (await f.call('ResolveRepositorySource', {...body,suffix:commit+'/hello.txt'})).json();
  assert.equal(exact.candidates.length,1); assert.deepEqual(exact.candidates[0],{selection:exact.selection,path:exact.path}); assert.equal(exact.path,'hello.txt'); assert.equal(exact.selection.commitId,commit);
  assert.equal((await f.call('ResolveRepositorySource', {...body,suffix:'main',path:'hello.txt'})).status,400);
});


test('bounded reads overlap while a queued revocation fences later reads, including failed reads', async () => {
  const events = []; let finishReads, finishWrite;
  const reads = new Promise(resolve => { finishReads = resolve; });
  const write = new Promise(resolve => { finishWrite = resolve; });
  let admitted = 0, maximum = 0;
  const run = serialize(async item => {
    events.push(item); maximum = Math.max(maximum, ++admitted);
    try { if (item.startsWith('read')) await reads; else await write; if (item === 'read-fail') throw Error('read failed'); }
    finally { admitted--; }
  }, item => item.startsWith('read'));
  const before = Array.from({ length: 10 }, (_, i) => run('read-' + i));
  const failed = run('read-fail').catch(error => error.message);
  const revoke = run('revoke'), after = run('read-after');
  await Promise.resolve(); assert.equal(events.length, 8); assert.equal(maximum, 8);
  finishReads(); await Promise.all(before); assert.equal(await failed, 'read failed');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(events.at(-1), 'revoke'); assert.ok(!events.includes('read-after'));
  finishWrite(); await Promise.all([revoke, after]); assert.equal(events.at(-1), 'read-after'); assert.equal(maximum, 8);
  const request = method => new Request('https://golf.example.com/rpc/golf.v1.RepositoryService/' + method, { method: 'POST' });
  assert.equal(concurrentRead(request('GetContents')), true);
  assert.equal(concurrentRead(request('GetRepositoryFileIndex')), true);
  for (const method of ['CreateRepository', 'SetRepositoryStar', 'Unknown']) assert.equal(concurrentRead(request(method)), false);
  assert.equal(concurrentRead({ci:true}), false);
});

test('native general settings enforce current grants, identity, revision and safe values', async t => {
  const f = await fixture(t); await f.create(); t.mock.method(globalThis,'fetch',f.providerFetch);
  const repository = { owner: 'alice', name: 'project' };
  const call = (method, body = {}, token = ownerToken) => f.call(method, { repository, ...body }, token, '/rpc/golf.v1.RepositorySettingsService/' + method);
  const initial = (await (await call('GetRepositorySettings')).json()).settings;
  assert.equal(initial.canEdit, true); assert.equal(initial.issuesMode, 'REPOSITORY_FEATURE_MODE_INTERNAL');
  const target = { repositoryId: initial.repositoryId, ownerId: initial.ownerId, expectedRevision: initial.revision };
  for (const patch of [{website:'javascript:alert(1)'},{website:'https://user:secret@example.com'}, {description:'bad\u0000'}, {defaultBranch:'other'}, {repositoryId:'9'}, {ownerId:'9'}]) {
    assert.ok((await call('UpdateRepositorySettings', {...target, ...patch})).status >= 400);
  }
  const saved = (await (await call('UpdateRepositorySettings', {...target,description:'Updated',website:'https://example.com'})).json()).settings;
  assert.equal(saved.description, 'Updated'); assert.notEqual(saved.revision, initial.revision);
  assert.equal((await call('UpdateRepositorySettings', {...target,description:'Stale'})).status, 412);
  const updated = {...target,expectedRevision:saved.revision};
  assert.equal((await call('UpdateRepositoryTopics', {...updated,topics:['golf','golf']})).status, 400);
  assert.equal((await call('UpdateRepositoryTopics', {...updated,topics:['Bad']})).status, 400);
  const topics = (await (await call('UpdateRepositoryTopics', {...updated,topics:['zebra','cloudflare']})).json()).settings;
  assert.deepEqual(topics.topics,['cloudflare','zebra']); assert.equal(topics.website,'https://example.com');
  const cleared = (await (await call('UpdateRepositoryTopics', {...target,expectedRevision:topics.revision})).json()).settings; assert.deepEqual(cleared.topics,[]);
  const listed = await (await f.call('ListRepositories')).json(); assert.equal(listed.repositories[0].description,'Updated');
  const observed = await (await f.call('GetRepository',{repository})).json(); assert.equal(observed.repository.description,'Updated');
  f.sql.prepare("INSERT INTO grants VALUES(1,2,'read')").run();
  assert.equal((await (await call('GetRepositorySettings', {}, readerToken)).json()).settings.canEdit,false);
  assert.equal((await call('UpdateRepositoryTopics',{...target,expectedRevision:topics.revision,topics:[]},readerToken)).status,404);
  f.sql.prepare('DELETE FROM grants WHERE user_id=2').run(); assert.equal((await call('GetRepositorySettings', {}, readerToken)).status,404);
});

test('warm Git objects never bypass a current repository grant or provider identity check', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  f.env.gitObjectCache = { objects:new Map(), pending:new Map(), bytes:0 };
  const body = {repository:{owner:'alice',name:'project'},repositoryId:'1',ref:commit,path:'hello.txt'};
  assert.equal((await f.call('GetContents',body)).status,200); assert.ok(f.env.gitObjectCache.objects.size>0);
  f.sql.prepare("INSERT INTO grants VALUES(1,2,'read')").run(); assert.equal((await f.call('GetContents',body,readerToken)).status,200);
  f.sql.prepare('DELETE FROM grants WHERE user_id=2').run(); assert.equal((await f.call('GetContents',body,readerToken)).status,404);
  f.env.ACCOUNT_ID = 'd'.repeat(32); const original = f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get = async name => {const repo=await original(name);repo.info=async()=>({name,remote:'https://foreign.example.com'});return repo;};
  assert.equal((await f.call('GetContents',body)).status,503);
});


test('directory change projection proves head changes and leaves unchanged entries for history reads', async t => {
  const f = await fixture(t); await f.create();
  const body = {repository:{owner:'alice',name:'project'},repositoryId:'1',includeLatestChanges:true};
  const root = (await (await f.call('GetContents',{...body,ref:commit})).json()).entries;
  assert.ok(root.every(entry=>entry.latestChange?.sha===commit));
  const unchanged = (await (await f.call('GetContents',{...body,ref:'b'.repeat(40)})).json()).entries;
  assert.ok(unchanged.every(entry=>!entry.latestChange));
});

test('native private image RPC rechecks grants and provider identity even with warm source objects', async t => {
  const f = await fixture(t); await f.create();
  const original = f.env.ARTIFACTS.get, svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  f.env.ARTIFACTS.get = async name => {
    const repo = await original(name);
    repo.readTree = async () => [{name:'README.md',hash:'1'.repeat(40),type:'blob'},{name:'logo.svg',hash:'2'.repeat(40),type:'blob'}];
    repo.readBlob = async hash => new Blob([hash === '1'.repeat(40) ? '![Logo](logo.svg)' : svg]);
    return repo;
  };
  f.env.gitObjectCache = { objects:new Map(), pending:new Map(), bytes:0 };
  const body = {repository:{owner:'alice',name:'project'},repositoryId:'1',commitId:commit,documentPath:'README.md',imageUrl:'logo.svg'};
  const result = await f.call('GetRepositoryImage',body); assert.equal(result.status,200);
  assert.equal(Buffer.from((await result.json()).content,'base64').toString(),svg);
  assert.equal(result.headers.get('Cache-Control'),'no-store'); assert.ok(f.env.gitObjectCache.objects.size>0);
  assert.equal((await f.call('GetRepositoryImage',body,readerToken)).status,404);
  f.sql.prepare("INSERT INTO grants VALUES(1,2,'read')").run(); assert.equal((await f.call('GetRepositoryImage',body,readerToken)).status,200);
  f.sql.prepare('DELETE FROM grants WHERE user_id=2').run(); assert.equal((await f.call('GetRepositoryImage',body,readerToken)).status,404);
  assert.equal((await f.call('GetRepositoryImage',{...body,repositoryId:'2'})).status,404);
  const get=f.env.ARTIFACTS.get; f.env.ARTIFACTS.get=async name=>{const repo=await get(name);repo.info=async()=>({name,remote:'https://foreign.example'});return repo;};
  assert.equal((await f.call('GetRepositoryImage',body)).status,503);
});

test('hosted maintenance retries original queue intent, bounds attempts and cancels expired work', async t => {
  const f = await evidenceFixture(t);
  const job = (await value(await f.evidence(f.input))).job;
  const original = f.sql.prepare('SELECT * FROM evidence_jobs WHERE id=?').get(job.id);
  f.sql.prepare("UPDATE evidence_jobs SET delivery='PENDING',updated_at='2000-01-01' WHERE id=?").run(job.id);
  assert.deepEqual(await reconcileEvidence(f.env, async () => assert.fail('Idle job is not running')), { resent: 1, stopped: 0, pending: 0 });
  assert.deepEqual(f.messages.at(-1), { jobId: job.id });
  assert.equal(f.sql.prepare('SELECT count(*) n FROM evidence_jobs').get().n, 1);
  assert.equal(f.sql.prepare('SELECT input_hash FROM evidence_jobs').get().input_hash, original.input_hash);
  f.sql.prepare("UPDATE evidence_jobs SET updated_at='2000-01-01',delivery='PENDING'").run();
  const send = f.env.EVIDENCE_QUEUE.send;
  f.env.EVIDENCE_QUEUE.send = async value => { await send(value); throw Error('Lost queue response'); };
  assert.equal((await reconcileEvidence(f.env, async () => {})).pending, 1);
  const count = f.messages.length;
  assert.equal((await reconcileEvidence(f.env, async () => {})).stopped, 1); assert.equal(f.messages.length, count);
  assert.equal(f.sql.prepare('SELECT state FROM evidence_jobs').get().state, 'REFUSED');
  f.sql.prepare("UPDATE evidence_jobs SET state='QUEUED',delivery='STARTED',delivery_attempts=3,test_state='RUNNING'").run();
  assert.deepEqual(await reconcileEvidence(f.env, async () => assert.fail('Publication attempts must not cancel an unexpired execution')), { resent: 0, stopped: 0, pending: 0 });
  assert.equal(f.sql.prepare('SELECT state FROM evidence_jobs').get().state, 'QUEUED');
  f.sql.prepare("UPDATE evidence_jobs SET state='QUEUED',delivery='STARTED',test_state='RUNNING',expires_at='2000-01-01'").run();
  let cancelled = 0;
  const failed = await reconcileEvidence(f.env, async () => { cancelled++; throw Error('Lost destruction acknowledgement'); });
  assert.equal(failed.pending, 1); assert.equal(f.sql.prepare('SELECT state FROM evidence_jobs').get().state, 'QUEUED');
  assert.equal((await reconcileEvidence(f.env, async value => { assert.equal(value.id, job.id); cancelled++; })).stopped, 1);
  assert.equal(cancelled, 2); assert.equal(f.sql.prepare('SELECT state FROM evidence_jobs').get().state, 'EXPIRED');
});


test('CFCR enablement is native, administrator-only and never accepts client authority', async t => {
  const f = await fixture(t); await f.create();
  const body = {repository: {owner: 'alice', name: 'project'}, repositoryId: '1', action: 'enable'};
  const path = '/native/repository-packages';
  assert.equal((await f.call('', body, ownerToken, path)).status, 501);
  const calls = [];
  f.env.REGISTRY_ORIGIN = 'https://registry.example.com';
  f.env.REGISTRY = {async manage(input) {calls.push(input); return {enabled: true, registry: f.env.REGISTRY_ORIGIN, name: input.binding.name, artifacts: []};}};
  f.sql.prepare("INSERT INTO grants VALUES(1,2,'read')").run();
  assert.equal((await f.call('', {...body, canManage: true}, readerToken, path)).status, 404);
  assert.equal(calls.length, 0);
  const response = await f.call('', {...body, actorId: '2', canPush: false}, ownerToken, path);
  assert.equal(response.status, 200); assert.equal((await response.json()).enabled, true);
  assert.equal(calls[0].actorId, '1'); assert.equal(calls[0].canPush, true);
  assert.equal(calls[0].binding.installation, f.env.PUBLIC_ORIGIN);
  assert.equal((await f.call('', {...body, repositoryId: '2'}, ownerToken, path)).status, 404);
  const read = await f.call('', {...body, action: 'credential', canPush: true}, readerToken, path);
  assert.equal(read.status, 200); assert.equal(calls.at(-1).canPush, false);
  const rescan = await f.call('', {...body, action: 'scan', reference: 'sha256:' + 'a'.repeat(64), force: true, idempotencyKey: crypto.randomUUID()}, ownerToken, path);
  assert.equal(rescan.status, 200); assert.equal(calls.at(-1).force, true); assert.equal(calls.at(-1).actorId, '1');
});

test('CFCR inherited authority rejects identity substitution and observes revocation', async t => {
  const {registryAuthority} = await import('./src/repository-settings.mjs');
  const f = await fixture(t); await f.create(); f.env.REGISTRY = {};
  const row = f.sql.prepare('SELECT * FROM repositories WHERE id=1').get();
  const input = {actorId: '1', binding: {contract: 1, installation: f.env.PUBLIC_ORIGIN, name: 'alice/project', repositoryId: '1', artifactName: row.artifact_name}};
  assert.deepEqual(await registryAuthority(f.env,input), {read:true,write:true,admin:true});
  for (const key of ['installation','name','repositoryId','artifactName']) assert.deepEqual(await registryAuthority(f.env,{...input,binding:{...input.binding,[key]:'wrong'}}),{read:false,write:false});
  f.sql.prepare("UPDATE grants SET role='read' WHERE user_id=1").run();
  assert.deepEqual(await registryAuthority(f.env,input),{read:true,write:false,admin:false});
  f.sql.prepare('UPDATE users SET active=0 WHERE id=1').run();
  assert.deepEqual(await registryAuthority(f.env,input),{read:false,write:false});
});

async function accessFixture(t) {
  const f = await fixture(t); await f.create();
  const repository = { owner: 'alice', name: 'project' };
  const call = (method, body = {}, token = ownerToken) => f.call(method, { repository, ...body }, token, '/rpc/golf.v1.RepositoryAccessService/' + method);
  const target = async (login = 'bob') => {
    const { access } = await (await call('GetRepositoryAccess')).json();
    const base = { repositoryId: access.repositoryId, ownerId: access.ownerId, expectedRevision: access.revision };
    const { collaborator } = await (await call('ResolveRepositoryCollaborator', { ...base, userLogin: login })).json();
    return { ...base, userLogin: login, userId: collaborator.user.id, expectedCollaboratorRevision: collaborator.revision, idempotencyKey: crypto.randomUUID() };
  };
  return { ...f, accessCall: call, target, repository };
}

test('native collaborators use current admin authority, bounded inventories and durable original receipts', async t => {
  const f = await accessFixture(t), input = { ...await f.target(), permission: 'write' };
  let response = await f.accessCall('SetRepositoryCollaborator', input);
  assert.equal(response.status, 200);
  const original = (await response.json()).operation;
  assert.equal(original.phase, 'SUCCEEDED'); assert.equal(original.observedEffectivePermission, 'write');
  assert.equal(original.generation, '1');
  const inspect = { repositoryId: '1', ownerId: input.ownerId, userId: '2', idempotencyKey: input.idempotencyKey, expectedRevision: input.expectedRevision };
  assert.deepEqual((await (await f.accessCall('GetRepositoryAccessOperation', inspect)).json()).operation, original);
  assert.deepEqual((await (await f.accessCall('SetRepositoryCollaborator', input)).json()).operation, original);
  assert.equal(f.sql.prepare('SELECT generation FROM collaborator_versions WHERE user_id=2').get().generation, 1);
  assert.equal((await f.accessCall('SetRepositoryCollaborator', { ...input, permission: 'admin' })).status, 409);
  const { access } = await (await f.accessCall('GetRepositoryAccess')).json();
  const list = { repositoryId: '1', ownerId: input.ownerId, expectedRevision: access.revision, page: { limit: 1 } };
  const first = await (await f.accessCall('ListRepositoryCollaborators', list)).json();
  assert.equal(first.collaborators[0].user.login, 'alice'); assert.equal(first.page.nextPage, 2);
  const second = await (await f.accessCall('ListRepositoryCollaborators', { ...list, page: { page: 2, limit: 1 } })).json();
  assert.equal(second.collaborators[0].user.login, 'bob'); assert.equal(second.collaborators[0].permission, 'write'); assert.equal(second.page.nextPage, 0);
  assert.equal((await f.accessCall('ListRepositoryCollaborators', { ...list, page: { limit: 101 } })).status, 400);
  for (const method of ['ListRepositoryCollaborators', 'ResolveRepositoryCollaborator', 'SetRepositoryCollaborator', 'RemoveRepositoryCollaborator', 'GetRepositoryAccessOperation']) {
    assert.equal((await f.accessCall(method, { ...input, userLogin: 'alice' }, readerToken)).status, 404, method);
  }
  assert.equal((await f.accessCall('GetRepositoryAccessOperation', { ...inspect, userId: '1' })).status, 404);
  assert.equal((await f.accessCall('SetRepositoryCollaborator', { ...await f.target('alice'), permission: 'read' })).status, 412);
  assert.equal((await f.accessCall('SetRepositoryCollaborator', { ...await f.target(), ownerId: '99', permission: 'read' })).status, 404);
});

test('collaborator revisions reject stale edits, including remove/re-add ABA and inactive recipients', async t => {
  const f = await accessFixture(t);
  const old = await f.target();
  assert.equal((await f.accessCall('SetRepositoryCollaborator', { ...old, permission: 'read' })).status, 200);
  const stale = await f.target();
  f.sql.exec("UPDATE grants SET role='write' WHERE user_id=2; UPDATE grants SET role='read' WHERE user_id=2");
  let response = await f.accessCall('SetRepositoryCollaborator', { ...stale, permission: 'admin' });
  assert.equal(response.status, 412); assert.equal(response.headers.get('Golf-Access-Effect'), 'none');
  const fresh = await f.target();
  response = await f.accessCall('SetRepositoryCollaborator', { ...fresh, expectedCollaboratorRevision: stale.expectedCollaboratorRevision, permission: 'admin' });
  assert.equal(response.status, 412);
  assert.equal((await f.accessCall('RemoveRepositoryCollaborator', fresh)).status, 200);
  assert.equal((await f.call('GetRepository', { repository: f.repository }, readerToken)).status, 404);
  const readd = await f.target();
  assert.equal((await f.accessCall('SetRepositoryCollaborator', { ...readd, permission: 'read' })).status, 200);
  assert.notEqual((await f.target()).expectedCollaboratorRevision, stale.expectedCollaboratorRevision);
  f.sql.exec('UPDATE users SET active=0 WHERE id=2');
  assert.equal((await f.accessCall('SetRepositoryCollaborator', { ...await f.target(), permission: 'write' })).status, 412);
  assert.equal((await f.accessCall('RemoveRepositoryCollaborator', await f.target())).status, 200);
  assert.equal(f.sql.prepare('SELECT count(*) AS total FROM grants WHERE user_id=2').get().total, 0);
  assert.equal(f.sql.prepare('SELECT generation FROM collaborator_versions WHERE user_id=2').get().generation, 6);
  const inspected = await (await f.accessCall('GetRepositoryAccessOperation', { ...old, userId: '2' })).json();
  assert.equal(inspected.operation.observedEffectivePermission, 'read'); assert.equal(inspected.operation.generation, '1'); assert.equal(inspected.collaborator, undefined);
});

test('access transaction rechecks authority and rolls back effects and receipts together', async t => {
  const f = await accessFixture(t), input = { ...await f.target(), permission: 'write' }, batch = f.env.DB.batch;
  f.env.DB.batch = async statements => { f.sql.exec("UPDATE grants SET role='read' WHERE user_id=1"); return batch(statements); };
  const denied = await f.accessCall('SetRepositoryCollaborator', input);
  assert.equal(denied.status, 412);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM repository_access_operations').get().n, 0);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grants WHERE user_id=2').get().n, 0);
  f.env.DB.batch = batch; f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=1");
  const next = { ...await f.target(), permission: 'read' };
  f.sql.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON grants WHEN NEW.user_id=2 BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
  assert.equal((await f.accessCall('SetRepositoryCollaborator', next)).status, 503);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM repository_access_operations').get().n, 0);
  f.sql.exec('DROP TRIGGER fail_grant');
  let lost = true;
  f.env.DB.batch = async statements => { const result = await batch(statements); if (lost) { lost = false; throw Error('Lost committed response'); } return result; };
  assert.equal((await f.accessCall('SetRepositoryCollaborator', next)).status, 503);
  const receipt = await (await f.accessCall('GetRepositoryAccessOperation', next)).json();
  assert.equal(receipt.operation.phase, 'SUCCEEDED');
  assert.equal((await f.accessCall('SetRepositoryCollaborator', next)).status, 200);
  assert.equal(f.sql.prepare('SELECT generation FROM collaborator_versions WHERE user_id=2').get().generation, 1);
});

async function invitationFixture(t) {
  const f = await accessFixture(t);
  f.sql.exec("UPDATE users SET email=login || '@example.invalid'; INSERT INTO users(id,login,email) VALUES(3,'charlie','charlie@example.invalid');");
  const dispatch = serialize(request => handle(request, f.env, f.providerFetch));
  const invite = (method, body = {}, email = 'alice@example.invalid') => dispatch(new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.RepositoryInvitationService/' + method, {
    method: 'POST', headers: { 'X-Golf-Native-Access-Email': email, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body),
  }));
  const prepare = async (login = 'bob', permission = 'write') => {
    const { access } = await (await f.accessCall('GetRepositoryAccess')).json();
    const target = { repository: f.repository, repositoryId: '1', ownerId: access.ownerId, expectedRevision: access.revision };
    const preview = await invite('PreviewRepositoryInvitationRecipient', { ...target, username: login });
    assert.equal(preview.status, 200, await preview.clone().text());
    const { recipient } = await preview.json();
    return { ...target, recipientId: recipient.user.id, recipientUsername: login, recipientRevision: recipient.revision, permission, persistentConsent: true, expiresAt: new Date(Date.now() + 86400000).toISOString(), idempotencyKey: crypto.randomUUID() };
  };
  const createInvitation = async (login = 'bob', permission = 'write') => {
    const input = await prepare(login, permission), response = await invite('CreateRepositoryInvitation', input);
    assert.equal(response.status, 200, await response.clone().text());
    return { input, invitation: (await response.json()).invitation };
  };
  return { ...f, invite, prepare, createInvitation };
}

test('native invitations create no grant until the enrolled recipient accepts; originals never regrant', async t => {
  const f = await invitationFixture(t), { input, invitation } = await f.createInvitation();
  assert.equal(invitation.state, 'PENDING'); assert.equal(invitation.revision, '1'); assert.equal(invitation.detailsAvailable, true);
  assert.equal((await f.call('GetRepository', { repository: f.repository }, readerToken)).status, 404);
  const duplicate = await f.invite('CreateRepositoryInvitation', input);
  assert.equal((await duplicate.json()).invitation.id, invitation.id);
  assert.equal((await f.invite('CreateRepositoryInvitation', { ...input, permission: 'admin' })).status, 409);
  assert.equal((await f.invite('CreateRepositoryInvitation', { ...input, idempotencyKey: crypto.randomUUID() })).status, 412);
  let inbox = await (await f.invite('ListOwnRepositoryInvitations', {}, 'bob@example.invalid')).json();
  assert.equal(inbox.invitations[0].repository.name, 'project'); assert.equal(inbox.invitations[0].recipient.id, '2');
  const decision = { invitationId: invitation.id, expectedRevision: invitation.revision, decision: 'REPOSITORY_INVITATION_DECISION_ACCEPT', idempotencyKey: crypto.randomUUID() };
  assert.equal((await f.invite('RespondRepositoryInvitation', decision, 'charlie@example.invalid')).status, 404);
  const accepted = await f.invite('RespondRepositoryInvitation', decision, 'bob@example.invalid');
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const receipt = await accepted.json(); assert.equal(receipt.invitation.state, 'ACCEPTED'); assert.equal(receipt.operation.phase, 'SUCCEEDED');
  assert.equal(f.sql.prepare('SELECT role FROM grants WHERE user_id=2').get().role, 'write');
  assert.equal((await f.call('GetRepository', { repository: f.repository }, readerToken)).status, 200);
  assert.deepEqual((await (await f.invite('RespondRepositoryInvitation', decision, 'bob@example.invalid')).json()).operation, receipt.operation);
  assert.equal((await f.invite('RespondRepositoryInvitation', { ...decision, decision: 2 }, 'bob@example.invalid')).status, 409);
  assert.equal((await f.invite('GetRepositoryInvitationOperation', decision, 'charlie@example.invalid')).status, 404);
  f.sql.exec('DELETE FROM grants WHERE user_id=2');
  const historical = await (await f.invite('RespondRepositoryInvitation', decision, 'bob@example.invalid')).json();
  assert.equal(historical.operation.phase, 'SUCCEEDED'); assert.equal(historical.invitation.detailsAvailable, false);
  assert.equal(historical.invitation.repository, undefined); assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grants WHERE user_id=2').get().n, 0);
  inbox = await (await f.invite('ListOwnRepositoryInvitations', {}, 'bob@example.invalid')).json();
  assert.equal(inbox.invitations[0].detailsAvailable, false);
});

test('invitations enforce human identity, consent, immutable recipient and expiry', async t => {
  const f = await invitationFixture(t), input = await f.prepare();
  const machine = await f.call('CreateRepositoryInvitation', input, ownerToken, '/rpc/golf.v1.RepositoryInvitationService/CreateRepositoryInvitation');
  assert.equal(machine.status, 403);
  for (const patch of [{ persistentConsent: false }, { permission: 'owner' }, { expiresAt: 'invalid' }, { expiresAt: new Date(Date.now() + 8 * 86400000).toISOString() }]) assert.equal((await f.invite('CreateRepositoryInvitation', { ...input, ...patch })).status, 400);
  assert.equal((await f.invite('CreateRepositoryInvitation', { ...input, recipientId: '3' })).status, 404);
  assert.equal((await f.invite('CreateRepositoryInvitation', { ...input, ownerId: '999' })).status, 404);
  const { invitation } = await f.createInvitation();
  f.sql.prepare("UPDATE repository_invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(invitation.id);
  const inbox = await (await f.invite('ListOwnRepositoryInvitations', {}, 'bob@example.invalid')).json();
  assert.equal(inbox.invitations[0].state, 'EXPIRED'); assert.equal(inbox.invitations[0].revision, '2');
  const response = await f.invite('RespondRepositoryInvitation', { invitationId: invitation.id, expectedRevision: '1', decision: 1, idempotencyKey: crypto.randomUUID() }, 'bob@example.invalid');
  assert.equal((await response.json()).operation.phase, 'REJECTED');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grants WHERE user_id=2').get().n, 0);
  assert.equal((await f.invite('ListOwnRepositoryInvitations', { page: { limit: 101 } }, 'bob@example.invalid')).status, 400);
});

test('issuer identity and grant ABA changes cancel invitation authority without disclosing target details', async t => {
  for (const change of ["UPDATE users SET active=0 WHERE id=1; UPDATE users SET active=1 WHERE id=1", "UPDATE grants SET role='read' WHERE user_id=1; UPDATE grants SET role='admin' WHERE user_id=1"]) {
    const f = await invitationFixture(t), { invitation } = await f.createInvitation();
    f.sql.exec(change);
    const inbox = await (await f.invite('ListOwnRepositoryInvitations', {}, 'bob@example.invalid')).json();
    assert.equal(inbox.invitations[0].detailsAvailable, false); assert.equal(inbox.invitations[0].repository, undefined);
    const response = await f.invite('RespondRepositoryInvitation', { invitationId: invitation.id, expectedRevision: '1', decision: 1, idempotencyKey: crypto.randomUUID() }, 'bob@example.invalid');
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.operation.phase, 'REJECTED'); assert.equal(result.operation.failureCode, 'preflight_refused');
    assert.equal(result.invitation.detailsAvailable, false);
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grants WHERE user_id=2').get().n, 0);
  }
});

test('decline/revoke and changed recipient grants never overwrite independently granted authority', async t => {
  const f = await invitationFixture(t), first = await f.createInvitation();
  const decision = i => ({ invitationId: i.id, expectedRevision: i.revision, decision: 2, idempotencyKey: crypto.randomUUID() });
  assert.equal((await (await f.invite('RespondRepositoryInvitation', decision(first.invitation), 'bob@example.invalid')).json()).invitation.state, 'REJECTED');
  const second = await f.createInvitation();
  const revoked = await f.invite('RevokeRepositoryInvitation', { ...second.input, invitationId: second.invitation.id, invitationRevision: '1' });
  assert.equal((await revoked.json()).invitation.state, 'REVOKED');
  assert.equal((await (await f.invite('RespondRepositoryInvitation', { ...decision(second.invitation), decision: 1 }, 'bob@example.invalid')).json()).operation.phase, 'REJECTED');
  const third = await f.createInvitation();
  f.sql.exec("INSERT INTO grants VALUES(1,2,'admin')");
  assert.equal((await (await f.invite('RespondRepositoryInvitation', { ...decision(third.invitation), decision: 1 }, 'bob@example.invalid')).json()).operation.phase, 'REJECTED');
  assert.equal(f.sql.prepare('SELECT role FROM grants WHERE user_id=2').get().role, 'admin');
});

test('invitation acceptance checks authority in its transaction and recovers a lost response once', async t => {
  const f = await invitationFixture(t), { invitation } = await f.createInvitation();
  const body = { invitationId: invitation.id, expectedRevision: '1', decision: 1, idempotencyKey: crypto.randomUUID() }, batch = f.env.DB.batch;
  f.env.DB.batch = async statements => { f.sql.exec("UPDATE grants SET role='read' WHERE user_id=1"); return batch(statements); };
  const refused = await f.invite('RespondRepositoryInvitation', body, 'bob@example.invalid');
  assert.equal(refused.status, 200, await refused.clone().text()); assert.equal((await refused.json()).operation.phase, 'REJECTED');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM grants WHERE user_id=2').get().n, 0);
  f.env.DB.batch = batch; f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=1");
  const another = await f.createInvitation('charlie');
  const next = { invitationId: another.invitation.id, expectedRevision: '1', decision: 1, idempotencyKey: crypto.randomUUID() };
  f.env.DB.batch = async statements => { await batch(statements); throw Error('Lost acceptance acknowledgement'); };
  assert.equal((await f.invite('RespondRepositoryInvitation', next, 'charlie@example.invalid')).status, 503);
  const recovered = await (await f.invite('GetRepositoryInvitationOperation', next, 'charlie@example.invalid')).json();
  assert.equal(recovered.operation.phase, 'SUCCEEDED');
  assert.equal((await f.invite('RespondRepositoryInvitation', next, 'charlie@example.invalid')).status, 200);
  assert.equal(f.sql.prepare('SELECT generation FROM collaborator_versions WHERE user_id=3').get().generation, 1);
});

async function resourcesFixture(t) {
  const f = await fixture(t); await f.create();
  const target = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1' };
  const value = async response => { assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const issue = (await value(await f.call('CreateIssue', { ...target, title: 'Metadata issue', idempotencyKey: crypto.randomUUID() }))).issue;
  const resource = async (kind, change = {}, original) => {
    const input = { ...target, operationId: crypto.randomUUID(), kind, ...(original ? { resourceId: original.id, expectedRevision: original.revision } : {}), ...change };
    return { input, ...await value(await f.call('SubmitDiscussionResourceOperation', input)) };
  };
  const label = (name = 'bug', extra = {}) => resource(1, { label: { name, color: 'FF0000', ...extra } });
  const read = async () => (await value(await f.call('GetIssue', { ...target, number: issue.number }))).issue;
  const update = async (patch, current, token = ownerToken) => f.call('UpdateIssue', { ...target, issueId: issue.id, number: issue.number, expectedRevision: (current || await read()).revision, idempotencyKey: crypto.randomUUID(), ...patch }, token);
  return { ...f, target, value, issue, resource, label, read, update };
}
test('native labels and milestones have durable receipts, unique names, revision-fenced edits and tombstones', async t => {
  const f = await resourcesFixture(t), created = await f.label();
  assert.equal(created.label.color, 'ff0000');
  assert.equal((await f.value(await f.call('SubmitDiscussionResourceOperation', created.input))).operation.observedResourceId, created.label.id);
  assert.equal((await f.call('SubmitDiscussionResourceOperation', { ...created.input, label: { name: 'other', color: 'ffffff' } })).status, 409);
  assert.equal((await f.value(await f.call('SubmitDiscussionResourceOperation', { ...created.input, operationId: crypto.randomUUID(), label: { name: 'BUG', color: 'ffffff' } }))).operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
  const edited = await f.resource(2, { label: { name: 'bug/new', color: 'abcdef', description: 'Fixes', exclusive: true } }, created.label);
  assert.notEqual(edited.label.revision, created.label.revision);
  assert.equal((await f.value(await f.call('SubmitDiscussionResourceOperation', { ...created.input, operationId: crypto.randomUUID(), kind: 3, resourceId: created.label.id, expectedRevision: created.label.revision, label: undefined }))).operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
  const removed = await f.resource(3, {}, edited.label);
  assert.equal((await f.value(await f.call('ListRepositoryLabels', f.target))).labels.length, 0);
  assert.deepEqual((await f.value(await f.call('GetDiscussionResourceOperation', { operationId: removed.input.operationId }))).operation, removed.operation);
  const replacement = await f.label('bug/new'); assert.notEqual(replacement.label.id, created.label.id);
  const milestone = await f.resource(4, { milestone: { title: 'v1', state: 1, dueDate: '2028-02-29' } });
  assert.equal(milestone.milestone.dueOn, '2028-02-29T00:00:00.000Z');
  assert.equal((await f.call('SubmitDiscussionResourceOperation', { ...milestone.input, operationId: crypto.randomUUID(), milestone: { title: 'bad', dueDate: '2027-02-29' } })).status, 400);
  assert.equal((await f.call('ListRepositoryLabels', { ...f.target, includeOrganizationLabels: true })).status, 501);
});
test('native issue metadata assignment, filters, milestone counts and removal work together', async t => {
  const f = await resourcesFixture(t), label = (await f.label()).label;
  const milestone = (await f.resource(4, { milestone: { title: 'v1', state: 1 } })).milestone;
  f.sql.prepare("INSERT INTO grants VALUES(1,2,'read')").run();
  const initial = await f.read(); assert.deepEqual(initial.metadata, { labelsKnown: true, assigneesKnown: true, milestoneKnown: true, labels: [], assignees: [] });
  await f.value(await f.update({ labels: { expectedLabelIds: [], labelIds: [label.id] } }));
  await f.value(await f.update({ milestone: { expectedMilestoneId: '0', milestoneId: milestone.id } }));
  await f.value(await f.update({ assignees: { expectedAssigneeIds: [], assignees: [{ id: '2', login: 'bob' }] } }));
  const current = await f.read(); assert.equal(current.metadata.labels[0].id, label.id); assert.equal(current.metadata.assignees[0].login, 'bob'); assert.equal(current.metadata.milestone.openIssues, '1');
  const filter = { ...f.target, query: { labelNames: ['bug'], milestoneTitle: 'v1', assignee: 'bob' } };
  assert.equal((await f.value(await f.call('ListIssues', filter))).issues.length, 1);
  assert.equal((await f.value(await f.call('ListIssues', { ...filter, query: { labelNames: ['other'] } }))).issues.length, 0);
  assert.equal((await f.update({ labels: { expectedLabelIds: [], labelIds: [] } }, initial)).status, 412);
  const renamed = await f.resource(2, { label: { name: 'fixed', color: 'ffffff' } }, label);
  assert.notEqual((await f.read()).revision, current.revision);
  await f.resource(3, {}, renamed.label);
  assert.equal((await f.read()).metadata.labels.length, 0);
  await f.value(await f.update({ state: 2 }));
  assert.equal((await f.read()).metadata.milestone.closedIssues, '1');
  await f.resource(6, {}, milestone);
  assert.equal((await f.read()).metadata.milestone, undefined);
  f.sql.prepare('DELETE FROM grants WHERE user_id=2').run();
  assert.equal((await f.read()).metadata.assignees.length, 0);
  assert.equal((await f.value(await f.call('ListIssues', { ...filter, query: { assignee: 'bob' } }))).issues.length, 0);
});
test('metadata rejects foreign IDs, conflicting exclusive labels, closed milestones and unauthorized changes', async t => {
  const f = await resourcesFixture(t), a = (await f.label('status/type/bug', { exclusive: true })).label, b = (await f.label('status/type/feature', { exclusive: true })).label;
  f.sql.prepare("INSERT INTO grants VALUES(1,2,'write')").run();
  assert.equal((await f.update({ labels: { labelIds: [a.id] } }, undefined, readerToken)).status, 404);
  assert.equal((await f.update({ labels: { labelIds: [a.id, b.id] } })).status, 400);
  assert.equal((await f.update({ labels: { labelIds: ['999'] } })).status, 404);
  assert.equal((await f.update({ labels: { labelIds: [b.id, a.id] } })).status, 400);
  assert.equal((await f.update({ labels: { labelIds: [a.id] }, title: 'mixed' })).status, 400);
  const archived = (await f.label('archived', { archived: true })).label;
  assert.equal((await f.update({ labels: { labelIds: [archived.id] } })).status, 412);
  const closed = (await f.resource(4, { milestone: { title: 'closed', state: 2 } })).milestone;
  assert.equal((await f.update({ milestone: { expectedMilestoneId: '0', milestoneId: closed.id } })).status, 412);
  assert.equal((await f.update({ assignees: { assignees: [{ id: '2', login: 'wrong' }] } })).status, 404);
  const created = await f.label('authority');
  assert.equal((await f.call('GetDiscussionResourceOperation', { operationId: created.input.operationId }, readerToken)).status, 404);
  f.sql.prepare('DELETE FROM grants WHERE user_id=1').run();
  assert.equal((await f.call('GetDiscussionResourceOperation', { operationId: created.input.operationId })).status, 404);
});
test('resource and metadata transactions refuse authority loss and recover original committed responses', async t => {
  const f = await resourcesFixture(t), batch = f.env.DB.batch;
  f.env.DB.batch = async statements => { f.sql.prepare("UPDATE grants SET role='read' WHERE user_id=1").run(); return batch.call(f.env.DB, statements); };
  const input = { ...f.target, operationId: crypto.randomUUID(), kind: 1, label: { name: 'denied', color: 'ffffff' } };
  assert.equal((await f.value(await f.call('SubmitDiscussionResourceOperation', input))).operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussion_resources').get().n, 0);
  f.sql.prepare("UPDATE grants SET role='admin' WHERE user_id=1").run(); f.env.DB.batch = batch;
  const label = (await f.label()).label;
  f.env.DB.batch = async statements => { f.sql.prepare("UPDATE grants SET role='read' WHERE user_id=1").run(); return batch.call(f.env.DB, statements); };
  assert.equal((await f.update({ labels: { labelIds: [label.id] } })).status, 412);
  assert.equal((await f.read()).metadata.labels.length, 0);
  f.sql.prepare("UPDATE grants SET role='admin' WHERE user_id=1").run();
  input.operationId = crypto.randomUUID();
  f.env.DB.batch = async statements => { await batch.call(f.env.DB, statements); throw Error('Lost committed resource response'); };
  assert.equal((await f.call('SubmitDiscussionResourceOperation', input)).status, 503);
  f.env.DB.batch = batch;
  const original = await f.value(await f.call('GetDiscussionResourceOperation', { operationId: input.operationId }));
  assert.equal(original.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  assert.deepEqual((await f.value(await f.call('SubmitDiscussionResourceOperation', input))).operation, original.operation);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussion_resources').get().n, 2);
});
test('metadata assignment rechecks label revisions and account identity inside the transaction', async t => {
  const f = await resourcesFixture(t), label = (await f.label()).label, batch = f.env.DB.batch;
  f.env.DB.batch = async statements => { f.sql.prepare('UPDATE discussion_resources SET revision=revision+1 WHERE id=?').run(label.id); return batch.call(f.env.DB, statements); };
  assert.equal((await f.update({ labels: { labelIds: [label.id] } })).status, 412);
  assert.equal((await f.read()).metadata.labels.length, 0);
  f.sql.prepare("INSERT INTO grants VALUES(1,2,'read')").run();
  f.env.DB.batch = async statements => { f.sql.prepare("UPDATE users SET login='changed' WHERE id=2").run(); return batch.call(f.env.DB, statements); };
  assert.equal((await f.update({ assignees: { assignees: [{ id: '2', login: 'bob' }] } })).status, 412);
  assert.equal((await f.read()).metadata.assignees.length, 0);
});

test('PR metadata uses the same resource identities and cannot borrow an issue or foreign repository', async t => {
  const f = await pullFixture(t);
  const target = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1' };
  const value = async response => { assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const labels = await value(await f.call('SubmitDiscussionResourceOperation', { ...target, kind: 1, label: { name: 'review', color: '123456' }, operationId: crypto.randomUUID() }));
  const pull = (await value(await f.call('GetPullRequest', { ...target, number: 1 }))).pullRequest;
  const input = { ...target, pullRequestId: pull.id, number: pull.number, expectedRevision: pull.revision, idempotencyKey: crypto.randomUUID(), labels: { labelIds: [labels.label.id] } };
  const result = await value(await f.call('UpdatePullRequest', input));
  assert.equal(result.pullRequest.metadata.labels[0].id, labels.label.id);
  const filtered = await value(await f.call('ListPullRequests', { ...target, query: { labelNames: ['review'] } }));
  assert.equal(filtered.pullRequests.length, 1);
  assert.equal((await f.call('UpdatePullRequest', { ...input, idempotencyKey: crypto.randomUUID(), expectedRevision: result.pullRequest.revision, pullRequestId: '999' })).status, 404);
  f.sql.exec("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(2,'other','','other',1,'other','other','ACTIVE','now'); INSERT INTO discussion_resources(repository_id,kind,name,payload) VALUES(2,'label','private','{}');");
  const foreign = String(f.sql.prepare('SELECT id FROM discussion_resources WHERE repository_id=2').get().id);
  assert.equal((await f.call('UpdatePullRequest', { ...input, idempotencyKey: crypto.randomUUID(), expectedRevision: result.pullRequest.revision, labels: { expectedLabelIds: [labels.label.id], labelIds: [foreign] } })).status, 404);
});
test('issue list metadata uses a bounded batch instead of per-row metadata reads', async t => {
  const f = await resourcesFixture(t);
  for (let i = 0; i < 20; i++) await f.value(await f.call('CreateIssue', { ...f.target, title: 'Issue ' + i, idempotencyKey: crypto.randomUUID() }));
  const prepare = f.env.DB.prepare; let reads = 0;
  f.env.DB.prepare = function(sql) { if (/^SELECT.*FROM discussion_(?:labels|assignees|milestones) a/.test(sql)) reads++; return prepare.call(this, sql); };
  const result = await f.value(await f.call('ListIssues', { ...f.target, page: { page: 1, limit: 100 } }));
  assert.equal(result.issues.length, 21); assert.equal(reads, 3);
});

test('native comment editing binds author, discussion, revision and original operation', async t => {
  const f = await resourcesFixture(t); f.sql.prepare("INSERT INTO grants VALUES(1,2,'read')").run();
  const posted = await f.value(await f.call('CreateIssueComment', { ...f.target, issueId: f.issue.id, number: f.issue.number, body: 'Reader comment', idempotencyKey: crypto.randomUUID() }, readerToken));
  const comment = posted.comment; assert.equal(comment.canEdit, true);
  const change = { ...f.target, kind: 7, operationId: crypto.randomUUID(), resourceId: comment.id, expectedRevision: comment.revision, issueId: f.issue.id, number: f.issue.number, commentBody: 'Edited by author' };
  assert.equal((await f.call('SubmitDiscussionResourceOperation', { ...change, number: 999 }, readerToken)).status, 404);
  assert.equal((await f.call('SubmitDiscussionResourceOperation', { ...change, pullRequest: true }, readerToken)).status, 404);
  const applied = await f.value(await f.call('SubmitDiscussionResourceOperation', change, readerToken));
  assert.equal(applied.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  const inventory = (await f.value(await f.call('ListIssueComments', { ...f.target, issueId: f.issue.id, number: f.issue.number }))).comments;
  assert.equal(inventory[0].body, 'Edited by author'); assert.notEqual(inventory[0].revision, comment.revision); assert.equal(inventory[0].canDelete, true);
  const stale = await f.value(await f.call('SubmitDiscussionResourceOperation', { ...change, operationId: crypto.randomUUID() }, readerToken));
  assert.equal(stale.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
  const deletion = { ...change, kind: 8, operationId: crypto.randomUUID(), expectedRevision: inventory[0].revision, commentBody: undefined };
  await f.value(await f.call('SubmitDiscussionResourceOperation', deletion));
  assert.equal((await f.read()).comments, 0);
  assert.deepEqual((await f.value(await f.call('SubmitDiscussionResourceOperation', change, readerToken))).operation, applied.operation);
  assert.equal((await f.read()).comments, 0);
  assert.equal((await f.call('SubmitDiscussionResourceOperation', { ...change, commentBody: 'Different input' }, readerToken)).status, 409);
  assert.equal((await f.call('GetDiscussionResourceOperation', { operationId: change.operationId })).status, 404);
});
test('comment mutations reject other readers and revoked authority inside the transaction', async t => {
  const f = await resourcesFixture(t); f.sql.prepare("INSERT INTO grants VALUES(1,2,'write')").run();
  const posted = await f.value(await f.call('CreateIssueComment', { ...f.target, issueId: f.issue.id, number: f.issue.number, body: 'Owner comment', idempotencyKey: crypto.randomUUID() }));
  const comment = posted.comment, input = { ...f.target, kind: 7, operationId: crypto.randomUUID(), resourceId: comment.id, expectedRevision: comment.revision, issueId: f.issue.id, number: f.issue.number, commentBody: 'Change' };
  assert.equal((await f.call('SubmitDiscussionResourceOperation', input, readerToken)).status, 404);
  const listed = await f.value(await f.call('ListIssueComments', { ...f.target, issueId: f.issue.id, number: f.issue.number }, readerToken));
  assert.equal(listed.comments[0].canEdit, false); assert.equal(listed.comments[0].canDelete, false);
  const batch = f.env.DB.batch;
  f.env.DB.batch = async statements => { f.sql.prepare('DELETE FROM grants WHERE user_id=1').run(); return batch.call(f.env.DB, statements); };
  const denied = await f.value(await f.call('SubmitDiscussionResourceOperation', input));
  assert.equal(denied.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
  assert.equal(f.sql.prepare('SELECT body FROM discussion_comments').get().body, 'Owner comment');
  f.env.DB.batch = batch; f.sql.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  assert.deepEqual((await f.value(await f.call('SubmitDiscussionResourceOperation', input))).operation, denied.operation);
});

test('large discussion metadata refuses an oversized page without truncating known labels', async t => {
  const f = await resourcesFixture(t);
  const insert = f.sql.prepare("INSERT INTO discussion_resources(repository_id,kind,name,payload) VALUES(1,'label',?,?)");
  const link = f.sql.prepare('INSERT INTO discussion_labels VALUES(1,?)');
  for (let i = 0; i < 1050; i++) { const result = insert.run('label'+i, JSON.stringify({ name: 'label'+i, description: 'x'.repeat(2000), color: 'ffffff' })); link.run(Number(result.lastInsertRowid)); }
  assert.equal((await f.call('GetIssue', { ...f.target, number: f.issue.number })).status, 429);
});

async function engagementFixture(t) {
  const f = await resourcesFixture(t);
  f.sql.exec("INSERT INTO grants VALUES(1,2,'read')");
  const target = { ...f.target, issueId: f.issue.id, number: f.issue.number, pullRequest: false };
  const engage = (method, body, token = readerToken) => f.call(method, body, token, '/rpc/golf.v1.DiscussionCollaborationService/' + method);
  const observe = async (commentId = '', token = readerToken) => f.value(await engage('GetDiscussionEngagement', { target: { ...target, commentId } }, token));
  const change = async (kind, extra = {}, token = readerToken) => {
    const observed = await observe(extra.reactionComment ? extra.resourceId : '', token);
    const input = { ...target, resourceId: f.issue.id, expectedRevision: observed.revision, operationId: nonce(), kind, ...extra };
    return { input, ...await f.value(await f.call('SubmitDiscussionResourceOperation', input, token)) };
  };
  return { ...f, target, engage, observe, change };
}

test('native reactions bind actor, target, revision and original receipt without ABA replay', async t => {
  const f = await engagementFixture(t);
  const initial = await f.observe(); assert.equal(initial.reactions.length, 8); assert.equal(initial.actorLogin, 'bob');
  const added = await f.change(9, { reaction: '+1' });
  assert.equal(added.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  assert.deepEqual((await f.observe()).reactions[0], { content: '+1', count: 1, reacted: true });
  assert.equal((await f.observe('', ownerToken)).reactions[0].reacted, false);
  await f.change(10, { reaction: '+1' });
  assert.notEqual((await f.observe()).revision, initial.revision);
  const replay = await f.value(await f.call('SubmitDiscussionResourceOperation', added.input, readerToken));
  assert.equal(replay.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  assert.equal((await f.observe()).reactions[0].count, 0);
  const stale = await f.value(await f.call('SubmitDiscussionResourceOperation', { ...added.input, operationId: nonce(), expectedRevision: initial.revision }, readerToken));
  assert.equal(stale.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
  assert.equal((await f.call('SubmitDiscussionResourceOperation', { ...added.input, reaction: 'heart' }, readerToken)).status, 409);
  assert.equal((await f.call('SubmitDiscussionResourceOperation', { ...added.input, operationId: nonce(), reaction: '<img>' }, readerToken)).status, 400);
});

test('subscriptions deliver current-authority in-app events, own read receipts and unsubscribe', async t => {
  const f = await engagementFixture(t);
  await f.change(11, { subscriptionLogin: 'bob' });
  assert.equal((await f.observe()).subscribed, true);
  const comment = { ...f.target, body: 'Hello subscriber', idempotencyKey: nonce() };
  await f.value(await f.call('CreateIssueComment', comment));
  await f.value(await f.call('CreateIssueComment', comment));
  const inbox = await f.value(await f.engage('ListOwnForgeNotifications', {}));
  assert.equal(inbox.notifications.length, 1); assert.equal(inbox.notifications[0].unread, true);
  assert.equal((await f.value(await f.engage('ListOwnForgeNotifications', {}, ownerToken))).notifications.length, 0);
  const n = inbox.notifications[0], input = { ...f.target, resourceId: n.id, expectedRevision: n.revision, operationId: nonce(), kind: 13 };
  assert.equal((await f.call('SubmitDiscussionResourceOperation', input)).status, 404);
  await f.value(await f.call('SubmitDiscussionResourceOperation', input, readerToken));
  assert.equal((await f.value(await f.engage('ListOwnForgeNotifications', {}))).notifications.length, 0);
  assert.equal((await f.value(await f.engage('ListOwnForgeNotifications', { includeRead: true }))).notifications.length, 1);
  const timeline = await f.value(await f.engage('ListDiscussionTimeline', { target: f.target }));
  assert.deepEqual(timeline.events.map(e => e.kind), ['opened', 'comment']);
  assert.ok(timeline.events.every(e => e.actor.login === 'alice'));
  await f.change(12, { subscriptionLogin: 'bob' });
  await f.value(await f.call('CreateIssueComment', { ...comment, idempotencyKey: nonce() }));
  assert.equal((await f.value(await f.engage('ListOwnForgeNotifications', { includeRead: true }))).notifications.length, 1);
  f.sql.exec('DELETE FROM grants WHERE user_id=2');
  assert.equal((await f.value(await f.engage('ListOwnForgeNotifications', { includeRead: true }))).notifications.length, 0);
  assert.equal((await f.engage('GetDiscussionEngagement', { target: f.target })).status, 404);
});

test('comment reactions do not collide with description IDs and deleted IDs are never reused', async t => {
  const f = await engagementFixture(t), comment = (await f.value(await f.call('CreateIssueComment', { ...f.target, body: 'Original', idempotencyKey: nonce() }))).comment;
  await f.change(9, { reaction: 'heart', resourceId: comment.id, reactionComment: true });
  assert.equal((await f.observe()).reactions.find(r => r.content === 'heart').count, 0);
  assert.equal((await f.observe(comment.id)).reactions.find(r => r.content === 'heart').count, 1);
  await f.value(await f.call('SubmitDiscussionResourceOperation', { ...f.target, resourceId: comment.id, expectedRevision: comment.revision, operationId: nonce(), kind: 8 }));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussion_reactions').get().n, 0);
  const next = (await f.value(await f.call('CreateIssueComment', { ...f.target, body: 'New', idempotencyKey: nonce() }))).comment;
  assert.notEqual(next.id, comment.id);
  assert.equal((await f.engage('GetDiscussionEngagement', { target: { ...f.target, commentId: comment.id } })).status, 404);
});

test('engagement refuses foreign discussions, spoofed subscription users and mid-transaction revocation', async t => {
  const f = await engagementFixture(t);
  assert.equal((await f.engage('GetDiscussionEngagement', { target: { ...f.target, issueId: '999' } })).status, 404);
  const observed = await f.observe(), input = { ...f.target, kind: 11, resourceId: f.issue.id, expectedRevision: observed.revision, operationId: nonce(), subscriptionLogin: 'alice' };
  assert.equal((await f.call('SubmitDiscussionResourceOperation', input, readerToken)).status, 400);
  const batch = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = statements => { f.sql.exec("UPDATE grants SET role='write' WHERE user_id=2; UPDATE grants SET role='read' WHERE user_id=2"); return batch(statements); };
  const refused = await f.value(await f.call('SubmitDiscussionResourceOperation', { ...input, subscriptionLogin: 'bob' }, readerToken));
  assert.equal(refused.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussion_subscriptions').get().n, 0);
});

test('lost engagement acknowledgement is inspectable and never repeats the mutation', async t => {
  const f = await engagementFixture(t), observed = await f.observe();
  const input = { ...f.target, kind: 9, resourceId: f.issue.id, expectedRevision: observed.revision, operationId: nonce(), reaction: 'rocket' };
  const batch = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = async statements => { await batch(statements); throw Error('Lost receipt'); };
  assert.equal((await f.call('SubmitDiscussionResourceOperation', input, readerToken)).status, 503);
  f.env.DB.batch = batch;
  const saved = await f.value(await f.call('GetDiscussionResourceOperation', { operationId: input.operationId }, readerToken));
  assert.equal(saved.operation.phase, 'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
  await f.value(await f.call('SubmitDiscussionResourceOperation', input, readerToken));
  assert.equal((await f.observe()).reactions.find(r => r.content === 'rocket').count, 1);
});

test('collaboration admission refuses revoked credentials, disabled identities and stale discussion writes atomically', async t => {
  for (const change of ["UPDATE credentials SET revoked=1", "UPDATE users SET active=0 WHERE id=1", "UPDATE users SET active=0 WHERE id=1; UPDATE users SET active=1 WHERE id=1", "UPDATE grants SET role='read' WHERE user_id=1; UPDATE grants SET role='admin' WHERE user_id=1", "UPDATE discussions SET revision=revision+1 WHERE id=1"]) {
    const f = await resourcesFixture(t), batch = f.env.DB.batch.bind(f.env.DB);
    const before = f.sql.prepare('SELECT count(*) AS n FROM collaboration_operations').get().n;
    f.env.DB.batch = statements => { f.sql.exec(change); return batch(statements); };
    const response = await f.update({ title: 'Refused title' }, f.issue);
    assert.equal(response.status, 412, change + ': ' + await response.text());
    assert.equal(f.sql.prepare('SELECT title FROM discussions WHERE id=1').get().title, 'Metadata issue');
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM collaboration_operations').get().n, before);
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM discussion_events').get().n, 1);
  }
});

test('collaboration inventories use constant D1 query counts as page size grows', async t => {
  const f = await resourcesFixture(t);
  for (let i = 0; i < 20; i++) await f.value(await f.call('CreateIssue', { ...f.target, title: 'Issue ' + i, idempotencyKey: nonce() }));
  const prepare = f.env.DB.prepare.bind(f.env.DB); let queries = 0;
  f.env.DB.prepare = query => { queries++; return prepare(query); };
  const count = async limit => { queries = 0; const result = await f.value(await f.call('ListIssues', { ...f.target, page: { limit } })); return { queries, result }; };
  const one = await count(1), many = await count(20);
  assert.equal(many.result.issues.length, 20); assert.equal(many.queries, one.queries);
});

async function webhookFixture(t) {
  const f = await fixture(t); await f.create();
  f.env.WEBHOOK_POLICY = JSON.stringify({ origins:['https://receiver.example.com'], dailyLimit:100 });
  f.env.WEBHOOK_KEY = { get:async()=>Buffer.alloc(32,7).toString('base64') };
  const target={repository:{owner:'alice',name:'project'},repositoryId:'1',ownerId:'1'};
  const invoke=(method,body,token=ownerToken)=>f.call(method,{target,...body},token,'/rpc/golf.v1.RepositoryWebhookService/'+method);
  const value=async response=>{const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  const draft={id:crypto.randomUUID(),expectedVersion:'0',name:'Review integration',endpoint:'https://receiver.example.com/private/path?token=private',signingSecret:'x'.repeat(40),eventTopics:['source','issues','pulls','actions'],enabled:true,authorizeBackground:true};
  return {...f,target,invoke,value,draft,save:async extra=>value(await invoke('SaveRepositoryWebhook',{...draft,...extra}))};
}

test('native webhooks encrypt private values, validate targets and fence stale saves',async t=>{
 const f=await webhookFixture(t), saved=await f.save();
 assert.equal(saved.subscription.version,'1');assert.equal(saved.subscription.authorizationState,'authorized');
 const secret=f.sql.prepare('SELECT * FROM webhook_subscriptions').get();
 assert.ok(!secret.encrypted.includes('private'));assert.ok(!secret.encrypted.includes(f.draft.signingSecret));
 const listed=await f.value(await f.invoke('ListRepositoryWebhooks',{}));
 assert.equal(listed.subscriptions.length,1);assert.equal(listed.backgroundAuthorizationSupported,true);
 assert.ok(!JSON.stringify(listed).includes('/private/'));assert.ok(!JSON.stringify(listed).includes(f.draft.signingSecret));
 assert.equal((await f.invoke('SaveRepositoryWebhook',f.draft)).status,412);
 assert.equal((await f.invoke('SaveRepositoryWebhook',{...f.draft,id:crypto.randomUUID(),endpoint:'https://evil.example.com/hook'})).status,400);
 for(const endpoint of ['https://127.0.0.1/x','https://[::1]/x','https://receiver.example.com@evil.example.com','https://receiver.example.com:8443/x','https://receiver.example.com/x#f','https://receiver.example.com/\\evil']) assert.equal((await f.invoke('SaveRepositoryWebhook',{...f.draft,id:crypto.randomUUID(),endpoint})).status,400);
 f.sql.exec("INSERT INTO grants VALUES(1,2,'read')");
 assert.equal((await f.invoke('ListRepositoryWebhooks',{},readerToken)).status,404);
 assert.equal((await f.invoke('ListRepositoryWebhooks',{target:{...f.target,ownerId:'2'}})).status,404);
 assert.equal((await f.invoke('SaveRepositoryWebhook',{...f.draft,expectedVersion:'1',endpoint:'',signingSecret:'',workflowNotifications:3})).status,200);
 assert.equal(f.sql.prepare('SELECT version FROM webhook_subscriptions').get().version,2);
});

test('native webhooks send Slack its own message shape for the same events',async t=>{
 const f=await webhookFixture(t);f.env.WEBHOOK_POLICY=JSON.stringify({origins:['https://receiver.example.com','https://hooks.slack.com'],dailyLimit:100});
 const endpoint='https://hooks.slack.com/services/T0000/B0000/placeholder';
 await f.save({endpoint});const {drainWebhooks}=await import('./src/webhooks.mjs');
 await f.value(await f.invoke('TestRepositoryWebhook',{subscriptionId:f.draft.id,expectedVersion:'1',operationId:crypto.randomUUID()}));
 f.sql.prepare("INSERT INTO webhook_deliveries(id,subscription_id,subscription_version,event_id,event_topic,payload,next_attempt_at,created_at) VALUES(?,?,1,'discussion:1','pulls','{\"schema\":\"golf.webhook.v1\"}','2000','2000')").run(crypto.randomUUID(),f.draft.id);
 const sent=[];
 await drainWebhooks(f.env,{fetch:async(url,options)=>{
   assert.equal(url,endpoint);const {createHmac}=await import('node:crypto');
   assert.equal(options.headers['X-Golf-Signature-256'],'sha256='+createHmac('sha256',f.draft.signingSecret).update(options.headers['X-Golf-Timestamp']+'\n'+options.headers['X-Golf-Event-ID']+'\n'+options.body).digest('hex'));
   sent.push(JSON.parse(options.body));return new Response('ok');
 }});
 const page=f.env.PUBLIC_ORIGIN+'/alice/project';
 assert.deepEqual(sent.sort((a,b)=>a.text.localeCompare(b.text)),[{text:`Pull requests changed in <${page}/pulls|alice/project>`},{text:`Webhook test in <${page}/settings/webhooks|alice/project>`}]);
});

test('native webhooks follow a repository to its named owner',async t=>{
 const f=await webhookFixture(t);
 assert.equal((await f.call('',{action:'ensurePersonal',userId:'1',expectedLogin:'alice',login:'mj'},ownerToken,'/native/owners')).status,200);
 const repository={owner:'mj',name:'project'};
 const access=(await (await f.call('GetRepositoryAccess',{repository},ownerToken,'/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess')).json()).access;
 const target={repository,repositoryId:access.repositoryId,ownerId:access.ownerId};
 const call=(method,body)=>f.call(method,{target,...body},ownerToken,'/rpc/golf.v1.RepositoryWebhookService/'+method);
 assert.equal((await f.invoke('ListRepositoryWebhooks',{})).status,404);
 assert.equal((await f.value(await call('SaveRepositoryWebhook',f.draft))).subscription.authorizationState,'authorized');
 assert.equal((await f.value(await call('ListRepositoryWebhooks',{}))).subscriptions.length,1);
});

test('native signed webhook tests retain original operations and never leak receiver bodies',async t=>{
 const f=await webhookFixture(t);await f.save();const {drainWebhooks}=await import('./src/webhooks.mjs');
 const input={subscriptionId:f.draft.id,expectedVersion:'1',operationId:crypto.randomUUID()};
 const queued=await f.value(await f.invoke('TestRepositoryWebhook',input));assert.equal(queued.delivery.state,'queued');
 let sent=0;
 const result=await drainWebhooks(f.env,{fetch:async(url,options)=>{
   sent++;assert.equal(url,f.draft.endpoint);assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');
   assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);
   const {createHmac}=await import('node:crypto');
   const expected=createHmac('sha256',f.draft.signingSecret).update(options.headers['X-Golf-Timestamp']+'\n'+options.headers['X-Golf-Event-ID']+'\n'+options.body).digest('hex');
   assert.equal(options.headers['X-Golf-Signature-256'],'sha256='+expected);
   assert.equal(options.headers['X-Golf-Delivery-ID'],input.operationId);
   return new Response('receiver-private-response',{status:202});
 }});
 assert.equal(result.processed,1);assert.equal(sent,1);
 const replay=await f.value(await f.invoke('TestRepositoryWebhook',input));assert.equal(replay.delivery.state,'accepted');assert.equal(replay.delivery.attempts,1);
 const history=await f.value(await f.invoke('ListRepositoryWebhookDeliveries',{subscriptionId:f.draft.id}));assert.equal(history.deliveries.length,1);assert.ok(!JSON.stringify(history).includes('receiver-private'));
 await f.save({expectedVersion:'1',enabled:false,authorizeBackground:false,endpoint:'',signingSecret:''});
 assert.equal((await f.value(await f.invoke('TestRepositoryWebhook',input))).delivery.state,'accepted');
 assert.equal((await drainWebhooks(f.env,{fetch:async()=>{throw Error('must not send');}})).processed,0);
});

test('removing a webhook origin in installation policy fails queued deliveries at their next attempt and refuses new saves',async t=>{
 const f=await webhookFixture(t);await f.save();const {drainWebhooks}=await import('./src/webhooks.mjs');const {withInstallationPolicy}=await import('./src/installation.mjs');
 const queued=await f.value(await f.invoke('TestRepositoryWebhook',{subscriptionId:f.draft.id,expectedVersion:'1',operationId:crypto.randomUUID()}));assert.equal(queued.delivery.state,'queued');
 f.sql.prepare("INSERT INTO installation_settings(key,value,version,updated_by,updated_at) VALUES('webhooks',?,1,1,'2026-10-14T00:00:00Z')").run(JSON.stringify({origins:['https://other.example.com'],dailyLimit:100}));
 // The deploy env alone would still send; the drain reads the policy in force at its start.
 assert.equal((await drainWebhooks(await withInstallationPolicy(f.env),{fetch:async()=>{throw Error('must not send');}})).processed,0);
 const row=f.sql.prepare('SELECT state,failure_code FROM webhook_deliveries').get();assert.equal(row.state,'failed');assert.equal(row.failure_code,'destination_or_credential_unavailable');
 assert.equal((await f.invoke('SaveRepositoryWebhook',{...f.draft,id:crypto.randomUUID()})).status,400);
});

test('webhook outbox captures committed source, discussion and test transitions with notification filters',async t=>{
 const f=await webhookFixture(t);await f.save();
 await f.sendPush();
 await f.value(await f.call('CreateIssue',{repository:f.target.repository,repositoryId:'1',title:'Work',body:'Private issue text',idempotencyKey:crypto.randomUUID()}));
 const time=new Date().toISOString(), job=crypto.randomUUID();
 f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,test_state,created_at,updated_at,expires_at) VALUES(?,1,1,?,'hash','{}','NONE','REQUESTED',?,?,?)").run(job,crypto.randomUUID(),time,time,time);
 f.sql.prepare("UPDATE evidence_jobs SET test_state='PASSED' WHERE id=?").run(job);
 const deliveries=f.sql.prepare('SELECT * FROM webhook_deliveries').all();assert.equal(deliveries.length,4);assert.deepEqual(deliveries.map(d=>d.event_topic).sort(),['actions','actions','issues','source']);
 assert.ok(deliveries.every(d=>!d.payload.includes('Private issue text')));
 const previous=deliveries.length;f.sql.exec('BEGIN');f.sql.prepare("UPDATE evidence_jobs SET test_state='FAILED' WHERE id=?").run(job);f.sql.exec('ROLLBACK');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM webhook_deliveries').get().n,previous);
 await f.save({expectedVersion:'1',workflowNotifications:'WORKFLOW_NOTIFICATION_MODE_FAILURES',endpoint:'',signingSecret:''});
 f.sql.prepare("UPDATE evidence_jobs SET test_state='CANCELLED' WHERE id=?").run(job);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM webhook_deliveries').get().n,previous);
 f.sql.prepare("UPDATE evidence_jobs SET test_state='FAILED' WHERE id=?").run(job);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM webhook_deliveries').get().n,previous+1);
});

test('webhook retries preserve IDs, bound attempts, do not follow redirects and disclose ambiguity',async t=>{
 const f=await webhookFixture(t);await f.save();const {drainWebhooks}=await import('./src/webhooks.mjs');
 const input={subscriptionId:f.draft.id,expectedVersion:'1',operationId:crypto.randomUUID()};await f.value(await f.invoke('TestRepositoryWebhook',input));
 await drainWebhooks(f.env,{fetch:async()=>{throw Error('network accepted but acknowledgment lost');}});
 let d=f.sql.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(input.operationId);assert.equal(d.state,'retrying');assert.equal(d.possible_duplicate,1);assert.equal(d.attempts,1);
 for(let i=1;i<6;i++){f.sql.prepare("UPDATE webhook_deliveries SET next_attempt_at='2000' WHERE id=?").run(input.operationId);await drainWebhooks(f.env,{fetch:async(_,options)=>{assert.equal(options.headers['X-Golf-Delivery-ID'],input.operationId);return new Response(null,{status:503});}});}
 d=f.sql.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(input.operationId);assert.equal(d.state,'failed');assert.equal(d.attempts,6);
 const retry={deliveryId:d.id,expectedVersion:'1',operationId:crypto.randomUUID()};const again=await f.value(await f.invoke('RedeliverRepositoryWebhook',retry));assert.equal(again.delivery.eventId,d.event_id);assert.equal(again.delivery.possibleDuplicate,true);
 await drainWebhooks(f.env,{fetch:async(_,options)=>{assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://forbidden.example.com'}});}});
 assert.equal((await f.value(await f.invoke('RedeliverRepositoryWebhook',retry))).delivery.state,'failed');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM webhook_deliveries').get().n,2);
});

test('webhook background authority stays revoked across grant and identity ABA and before dispatch',async t=>{
 const f=await webhookFixture(t);await f.save();const {drainWebhooks}=await import('./src/webhooks.mjs');
 const queue=()=>f.invoke('TestRepositoryWebhook',{subscriptionId:f.draft.id,expectedVersion:'1',operationId:crypto.randomUUID()});await f.value(await queue());
 f.sql.exec("UPDATE grants SET role='read' WHERE user_id=1; UPDATE grants SET role='admin' WHERE user_id=1");
 const paused=await f.value(await f.invoke('ListRepositoryWebhooks',{}));assert.equal(paused.subscriptions[0].authorizationState,'authority_unavailable');
 let sends=0;await drainWebhooks(f.env,{fetch:async()=>{sends++;return new Response();}});assert.equal(sends,0);assert.equal(f.sql.prepare('SELECT state FROM webhook_deliveries').get().state,'cancelled');
 await f.save({expectedVersion:'1',endpoint:'',signingSecret:''});await f.value(await f.invoke('TestRepositoryWebhook',{subscriptionId:f.draft.id,expectedVersion:'2',operationId:crypto.randomUUID()}));
 const get=f.env.WEBHOOK_KEY.get;f.env.WEBHOOK_KEY.get=async()=>{f.sql.exec('UPDATE users SET active=0 WHERE id=1; UPDATE users SET active=1 WHERE id=1');return get();};
 await drainWebhooks(f.env,{fetch:async()=>{sends++;return new Response();}});assert.equal(sends,0);
});

test('webhook save rechecks credentials after encryption and disable works with an unavailable key',async t=>{
 const f=await webhookFixture(t);await f.save();
 const get=f.env.WEBHOOK_KEY.get;f.env.WEBHOOK_KEY.get=async()=>{throw Error('key unavailable');};
 const disabled=await f.save({expectedVersion:'1',enabled:false,endpoint:'',signingSecret:''});assert.equal(disabled.subscription.enabled,false);
 f.env.WEBHOOK_KEY.get=async()=>{f.sql.exec('UPDATE credentials SET revoked=1 WHERE user_id=1');return get();};
 assert.equal((await f.invoke('SaveRepositoryWebhook',{...f.draft,expectedVersion:'2'})).status,412);
 assert.equal(f.sql.prepare('SELECT enabled FROM webhook_subscriptions').get().enabled,0);
});

test('webhook daily limits and concurrent drains do not duplicate successful delivery',async t=>{
 const f=await webhookFixture(t);await f.save();const {drainWebhooks}=await import('./src/webhooks.mjs');
 f.env.WEBHOOK_POLICY=JSON.stringify({origins:['https://receiver.example.com'],dailyLimit:1});
 for(let i=0;i<2;i++)await f.value(await f.invoke('TestRepositoryWebhook',{subscriptionId:f.draft.id,expectedVersion:'1',operationId:crypto.randomUUID()}));
 let sends=0;const transport={fetch:async()=>{sends++;return new Response(null,{status:204});}};
 await Promise.all([drainWebhooks(f.env,transport),drainWebhooks(f.env,transport)]);
 assert.equal(sends,1);assert.equal(f.sql.prepare('SELECT attempts FROM webhook_daily').get().attempts,1);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM webhook_deliveries WHERE state='queued'").get().n,1);
});

test('webhook setup bindings reject malformed egress and secret references',async()=>{
 const {webhookBindings}=await import('./src/webhooks.mjs');
 const policy={origins:['https://receiver.example.com'],dailyLimit:100,key:{store:'a'.repeat(32),name:'webhook-key'}};
 assert.deepEqual(webhookBindings({}),{});
 assert.equal(webhookBindings({origin:'https://golf.example.com',webhooks:policy}).WEBHOOK_KEY.type,'secrets-store-secret');
 for(const patch of [{dailyLimit:true},{dailyLimit:5001},{origins:['https://127.0.0.1']},{origins:['https://golf.example.com']},{origins:['https://receiver.example.com/']},{key:{store:'a'.repeat(32),name:'../secret'}}])
   assert.throws(()=>webhookBindings({origin:'https://golf.example.com',webhooks:{...policy,...patch}}));
});

test('webhook credentials bind to subscription identity and expired leases retain delivery identity',async t=>{
 const {drainWebhooks}=await import('./src/webhooks.mjs'),f=await webhookFixture(t);
 const first=(await f.save()).subscription,second=(await f.save({id:crypto.randomUUID()})).subscription;
 const operationId=crypto.randomUUID();
 await f.value(await f.invoke('TestRepositoryWebhook',{subscriptionId:first.id,expectedVersion:'1',operationId}));
 const original=f.sql.prepare('SELECT encrypted FROM webhook_subscriptions WHERE id=?').get(first.id).encrypted;
 f.sql.prepare('UPDATE webhook_subscriptions SET encrypted=(SELECT encrypted FROM webhook_subscriptions WHERE id=?) WHERE id=?').run(second.id,first.id);
 let requests=0;await drainWebhooks(f.env,{fetch:async()=>{requests++;return new Response(null,{status:204});}});
 assert.equal(requests,0);assert.equal(f.sql.prepare('SELECT failure_code FROM webhook_deliveries WHERE id=?').get(operationId).failure_code,'destination_or_credential_unavailable');
 f.sql.prepare('UPDATE webhook_subscriptions SET encrypted=? WHERE id=?').run(original,first.id);
 const retryId=crypto.randomUUID();await f.value(await f.invoke('RedeliverRepositoryWebhook',{deliveryId:operationId,expectedVersion:'1',operationId:retryId}));
 f.sql.prepare("UPDATE webhook_deliveries SET state='sending',attempts=1,lease='lost',lease_until='2000-01-01T00:00:00Z' WHERE id=?").run(retryId);
 await drainWebhooks(f.env,{fetch:async(_url,options)=>{requests++;assert.equal(options.headers['X-Golf-Delivery-ID'],retryId);return new Response(null,{status:204});}});
 const delivered=f.sql.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(retryId);
 assert.equal(requests,1);assert.equal(delivered.state,'accepted');assert.equal(delivered.attempts,2);assert.equal(delivered.possible_duplicate,1);
});

async function rulesFixture(t) {
 const f=await fixture(t);await f.create();f.sql.exec("UPDATE users SET email=login||'@example.com'");
 const target={repository:{owner:'alice',name:'project'},repositoryId:'1',ownerId:'1'};
 const human=(method,body={},email='alice@example.com')=>f.dispatch(new Request(f.env.PUBLIC_ORIGIN+'/rpc/golf.v1.RepositoryRulesService/'+method,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1',Origin:f.env.PUBLIC_ORIGIN,'X-Golf-Native-Access-Email':email},body:JSON.stringify({...target,...body})}));
 const access=async()=> (await value(await f.call('GetRepositoryAccess',target,ownerToken,'/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess'))).access;
 const current=async()=>value(await human('GetRepositoryRules',{expectedRevision:(await access()).revision}));
 const input=async fields=>{const r=await current();return {operationId:crypto.randomUUID(),expectedAccessRevision:r.accessRevision,expectedRulesRevision:r.rulesRevision,...(fields.desiredBranch?{ruleName:fields.desiredBranch.ruleName}:{}),...fields};};
 const mutate=async fields=>value(await human('MutateRepositoryRules',await input(fields)));
 const write=(ref='refs/heads/main',old=zero,next=commit,token=ownerToken)=>f.dispatch(new Request(f.env.PUBLIC_ORIGIN+'/git/alice/project.git/git-receive-pack',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-git-receive-pack-request'},body:next===zero?Buffer.concat([packetLine(old+' '+next+' '+ref+'\0report-status delete-refs\n'),Buffer.from('0000')]):push(ref,old,next)}));
 const branch={ruleName:'main',priority:'1',requiredApprovals:'0',blockAdminMergeOverride:true};
 return {...f,target,human,access,current,input,mutate,write,branch};
}

test('native rules block branch creation, forced updates and deletion including administrators; original receipts never restore removed rules',async t=>{
 const f=await rulesFixture(t),before=await f.current();assert.deepEqual(before.branchProtections,[]);
 const input=await f.input({action:'REPOSITORY_RULE_MUTATION_ACTION_CREATE_BRANCH',desiredBranch:f.branch});
 const created=await value(await f.human('MutateRepositoryRules',input));assert.equal(created.operation.phase,'SUCCEEDED');
 for(const [old,next] of [[zero,commit],[commit,'b'.repeat(40)],[commit,zero]]) assert.equal((await f.write('refs/heads/main',old,next)).status,403);
 assert.equal(f.counts().effects,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_operations').get().n,0);
 assert.equal((await f.write('refs/heads/topic')).status,200);
 const changed=await f.mutate({action:2,ruleName:'main',desiredBranch:f.branch});assert.equal(changed.operation.phase,'SUCCEEDED');
 assert.notEqual(changed.currentRules.rulesRevision,created.currentRules.rulesRevision);
 const removed=await f.mutate({action:3,ruleName:'main'});assert.equal(removed.operation.phase,'SUCCEEDED');
 const replay=await value(await f.human('MutateRepositoryRules',input));assert.deepEqual(replay,created);
 assert.equal((await f.current()).branchProtections.length,0);
 assert.equal((await f.write()).status,200);
 assert.deepEqual((await value(await f.human('GetRepositoryRuleMutation',{operationId:input.operationId}))).operation,created.operation);
 assert.equal((await f.human('MutateRepositoryRules',{...input,desiredBranch:{...f.branch,ruleName:'other'}})).status,409);
});

test('native tag restrictions combine and bind enrolled account IDs; reader and API bearer cannot administer rules',async t=>{
 const f=await rulesFixture(t);f.sql.exec("INSERT INTO grants VALUES(1,2,'write')");
 const first=await f.mutate({action:4,desiredTag:{namePattern:'v*',allowedUsernames:['alice']}});assert.equal(first.operation.phase,'SUCCEEDED');
 assert.ok(!JSON.stringify(first.currentRules).includes('allowedActors'));
 assert.equal((await f.write('refs/tags/v1')).status,200);
 assert.equal((await f.write('refs/tags/v2',zero,commit,readerToken)).status,403);
 const locked=await f.mutate({action:4,desiredTag:{namePattern:'v-private*',allowedUsernames:[]}});assert.equal(locked.operation.phase,'SUCCEEDED');
 assert.equal((await f.write('refs/tags/v-private1')).status,403);
 const edited=await f.mutate({action:5,tagId:locked.currentRules.tagProtections[1].id,desiredTag:{namePattern:'v-private*',allowedUsernames:['alice']}});assert.equal(edited.operation.phase,'SUCCEEDED');
 assert.equal((await f.write('refs/tags/v-private1')).status,200);
 assert.equal((await f.human('GetRepositoryRules',{expectedRevision:(await f.access()).revision},'bob@example.com')).status,404);
 assert.equal((await f.call('GetRepositoryRules',{...f.target,expectedRevision:(await f.access()).revision},ownerToken,'/rpc/golf.v1.RepositoryRulesService/GetRepositoryRules')).status,404);
 const remove=await f.mutate({action:6,tagId:first.currentRules.tagProtections[0].id});assert.equal(remove.operation.phase,'SUCCEEDED');
 assert.equal((await f.write('refs/tags/v2',zero,commit,readerToken)).status,200);
});

test('native rules refuse unsupported settings and stale revisions with inspectable original receipts',async t=>{
 const f=await rulesFixture(t),staleInput=await f.input({action:1,desiredBranch:f.branch});
 assert.equal((await f.human('CreateRepository',{name:'unexpected',idempotencyKey:crypto.randomUUID()})).status,501);
 assert.equal((await f.human('UnknownRuleMethod')).status,501);
 await f.mutate({action:1,desiredBranch:{...f.branch,ruleName:'release/*'}});
 let result=await value(await f.human('MutateRepositoryRules',staleInput));assert.equal(result.operation.phase,'REJECTED');assert.equal(result.currentRules,undefined);
 assert.equal((await value(await f.human('GetRepositoryRuleMutation',{operationId:staleInput.operationId}))).operation.phase,'REJECTED');
 for(const fields of [{action:7,desiredMerge:{allowMergeCommits:true}},{action:1,desiredBranch:{...f.branch,enablePush:true}},{action:1,desiredBranch:{...f.branch,requiredApprovals:'1'}},{action:4,desiredTag:{namePattern:'v*',allowedTeams:['owners']}},{action:4,desiredTag:{namePattern:'v*',allowedTeams:{}}},{action:4,desiredTag:{namePattern:'v*',allowedUsernames:false}},{action:4,desiredTag:{namePattern:'v*',allowedUsernames:['unknown']}}]) {
  result=await f.mutate(fields);assert.equal(result.operation.phase,'REJECTED');assert.equal(result.currentRules,undefined);
 }
 assert.equal((await f.current()).branchProtections.length,1);assert.equal((await f.write('refs/heads/release/nested/work')).status,403);
 assert.equal((await f.write('refs/heads/release-other')).status,200);
});

test('native rules detect access ABA at the effect transaction and block edits during unresolved Git writes',async t=>{
 const f=await rulesFixture(t),input=await f.input({action:1,desiredBranch:f.branch}),db=f.env.DB.withSession('first-primary');
 f.env.DB.withSession=()=>({...db,batch:async statements=>{f.sql.exec("DELETE FROM grants WHERE repository_id=1 AND user_id=1; INSERT INTO grants VALUES(1,1,'admin')");return db.batch(statements);}});
 const rejected=await value(await f.human('MutateRepositoryRules',input));assert.equal(rejected.operation.phase,'REJECTED');
 f.env.DB.withSession=()=>db;assert.equal((await f.current()).branchProtections.length,0);
 f.losePush();assert.match(await refusal(await f.write()),/outcome of this update is unknown/);
 assert.equal((await f.mutate({action:1,desiredBranch:f.branch})).operation.phase,'REJECTED');
 assert.equal((await f.current()).branchProtections.length,0);
});

test('Git authority and rule revision are rechecked after provider lookup, before any canonical effect',async t=>{
 for(const change of ['permission','credential','identity','rules']) {
  const f=await rulesFixture(t),get=f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get=async name=>{
   const repo=await get(name),info=repo.info;
   repo.info=async()=>{const result=await info();
    if(change==='permission')f.sql.exec("DELETE FROM grants WHERE repository_id=1 AND user_id=1");
    if(change==='credential')f.sql.exec('UPDATE credentials SET revoked=1');
    if(change==='identity')f.sql.exec('UPDATE users SET active=0 WHERE id=1; UPDATE users SET active=1 WHERE id=1');
    if(change==='rules')f.sql.prepare('INSERT INTO repository_rules VALUES(?,?,?,?,?,?)').run(1,name,1,JSON.stringify([f.branch]),'[]',1);
    return result;
   };return repo;
  };
  assert.equal((await f.write()).status,412,change);assert.equal(f.counts().effects,0,change);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_operations').get().n,0);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
 }
});

test('native rule patterns have literal and prefix semantics without arbitrary glob expansion',async()=>{
 const {rulePattern}=await import('./src/repository-rules.mjs');
 for(const pattern of ['main','release/*','v*','*','features/nested'])assert.equal(rulePattern(pattern),pattern);
 for(const pattern of ['', 'release/**','x*y','x?','[main]','../main','a//b',' a','a.lock','a.lock*','refs/../x','x\\y'])assert.throws(()=>rulePattern(pattern));
});

test('rule receipts recover lost acknowledgements and roll back policy when the receipt cannot commit',async t=>{
 const f=await rulesFixture(t),input=await f.input({action:1,desiredBranch:f.branch}),db=f.env.DB.withSession('first-primary');
 f.env.DB.withSession=()=>({...db,batch:async statements=>{await db.batch(statements);throw Error('Lost acknowledgement');}});
 assert.equal((await f.human('MutateRepositoryRules',input)).status,503);
 f.env.DB.withSession=()=>db;
 const receipt=await value(await f.human('GetRepositoryRuleMutation',{operationId:input.operationId}));assert.equal(receipt.operation.phase,'SUCCEEDED');
 const replay=await value(await f.human('MutateRepositoryRules',input));assert.deepEqual(replay.operation,receipt.operation);
 assert.equal(f.sql.prepare('SELECT version FROM repository_rules').get().version,1);
 const remove=await f.input({action:3,ruleName:'main'});
 f.sql.exec("CREATE TRIGGER refuse_rule_receipt BEFORE INSERT ON repository_rule_operations BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
 assert.equal((await f.human('MutateRepositoryRules',remove)).status,503);
 assert.equal((await f.current()).branchProtections.length,1);assert.equal((await f.write()).status,403);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM repository_rule_operations WHERE operation_id=?').get(remove.operationId).n,0);
 f.sql.exec('DROP TRIGGER refuse_rule_receipt');
 assert.equal((await value(await f.human('MutateRepositoryRules',remove))).operation.phase,'SUCCEEDED');
});

test('tag allowlists do not transfer with reused account names',async t=>{
 const f=await rulesFixture(t);f.sql.exec("INSERT INTO grants VALUES(1,2,'write')");
 assert.equal((await f.mutate({action:4,desiredTag:{namePattern:'v*',allowedUsernames:['bob']}})).operation.phase,'SUCCEEDED');
 f.sql.exec("UPDATE users SET login='former-bob' WHERE id=2; UPDATE users SET login='bob' WHERE id=1");
 assert.equal((await f.write('refs/tags/v1')).status,403);
 assert.equal((await f.write('refs/tags/v1',zero,commit,readerToken)).status,200);
});

async function credentialsFixture(t) {
 const f=await rulesFixture(t);
 const human=(method,body={},email='alice@example.com',headers={})=>f.dispatch(new Request(f.env.PUBLIC_ORIGIN+'/rpc/golf.v1.GitTransportService/'+method,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1',Origin:f.env.PUBLIC_ORIGIN,'X-Golf-Native-Access-Email':email,...headers},body:JSON.stringify({...f.target,...body})}));
 const issue=(mode=1,email='alice@example.com')=>human('CreateGitCredential',{label:'Work laptop',mode,lifetimeSeconds:900},email).then(value);
 const git=(secret,service='git-upload-pack',repo='alice/project',body)=>f.dispatch(new Request(f.env.PUBLIC_ORIGIN+'/git/'+repo+'.git/'+(body?'git-receive-pack':'info/refs?service='+service),{method:body?'POST':'GET',headers:{Authorization:'Basic '+btoa('golf:'+secret),...(body?{'Content-Type':'application/x-git-receive-pack-request'}:{})},...(body?{body}:{})}));
 return {...f,humanCredential:human,issue,git};
}

test('native Git credentials show once, persist only hashes and authorize scoped clone/fetch advertisements',async t=>{
 const f=await credentialsFixture(t),info=await value(await f.humanCredential('GetGitTransport'));
 assert.equal(info.cloneUrl,f.env.PUBLIC_ORIGIN+'/git/alice/project.git');assert.equal(info.writeCredentialAvailable,true);
 const issued=await f.issue();assert.match(issued.secret,/^golf_git_[A-Za-z0-9_-]{43}$/);
 assert.equal(issued.credential.identityBound,true);assert.equal(issued.credential.sourceIdentityActive,true);assert.equal(issued.credential.sourceSessionId,undefined);
 assert.equal(f.sql.prepare('SELECT digest FROM git_credentials').get().digest,await digest(issued.secret));
 assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM git_credentials').get()).includes(issued.secret));
 const list=await value(await f.humanCredential('ListGitCredentials'));assert.equal(list.credentials.length,1);assert.ok(!JSON.stringify(list).includes('digest'));assert.ok(!JSON.stringify(list).includes(issued.secret));
 assert.equal((await f.git(issued.secret)).status,200);
 assert.equal((await f.git(issued.secret,'git-receive-pack')).status,404);
 assert.equal((await f.git(issued.secret,'git-receive-pack','alice/project',push())).status,404);assert.equal(f.counts().effects,0);
 const missing=await f.dispatch(new Request(f.env.PUBLIC_ORIGIN+'/git/alice/project.git/info/refs?service=git-upload-pack'));
 assert.equal(missing.status,401);assert.equal(missing.headers.get('WWW-Authenticate'),'Basic realm="Golf Git"');
});

test('write Git credentials obey branch locks and tag restrictions and cannot call application RPCs',async t=>{
 const f=await credentialsFixture(t),{secret}=await f.issue(2);
 await f.mutate({action:1,desiredBranch:f.branch});
 assert.equal((await f.git(secret,'git-receive-pack','alice/project',push())).status,403);
 assert.equal((await f.git(secret,'git-receive-pack','alice/project',push('refs/heads/topic'))).status,200);
 await f.mutate({action:4,desiredTag:{namePattern:'v*',allowedUsernames:[]}});
 assert.equal((await f.git(secret,'git-receive-pack','alice/project',push('refs/tags/v1'))).status,403);
 for(const authorization of ['Bearer '+secret,'Basic '+btoa('golf:'+secret)]) {
  assert.equal((await f.humanCredential('CreateGitCredential',{label:'escalate',mode:2,lifetimeSeconds:300},'alice@example.com',{Authorization:authorization})).status,401);
  assert.equal((await f.call('GetSession',{},secret,'/rpc/golf.v1.SessionService/GetSession')).status,401);
 }
 assert.equal(f.counts().effects,1);
});

test('Git credential administration stays own-account, human-only and within current repository access',async t=>{
 const f=await credentialsFixture(t);f.sql.exec("INSERT INTO grants VALUES(1,2,'read')");
 const issued=await f.issue(),bob=await f.issue(1,'bob@example.com');
 assert.equal((await f.humanCredential('CreateGitCredential',{label:'write',mode:2,lifetimeSeconds:300},'bob@example.com')).status,404);
 assert.equal((await value(await f.humanCredential('GetGitTransport',{},'bob@example.com'))).writeCredentialAvailable,false);
 assert.deepEqual((await value(await f.humanCredential('ListGitCredentials',{},'bob@example.com'))).credentials.map(c=>c.id),[bob.credential.id]);
 assert.equal((await f.humanCredential('RevokeGitCredential',{credentialId:issued.credential.id},'bob@example.com')).status,404);
 for(const headers of [{Authorization:'Bearer '+ownerToken},{'CF-Access-Client-Id':'machine'},{Origin:'https://other.example'}]) assert.ok([403,404].includes((await f.humanCredential('CreateGitCredential',{label:'test',mode:1,lifetimeSeconds:300},'alice@example.com',headers)).status));
 await value(await f.call('CreateRepository',{name:'other',private:true,idempotencyKey:crypto.randomUUID()}));
 assert.equal((await f.git(issued.secret,'git-upload-pack','alice/other')).status,401);
 assert.equal((await f.git(issued.secret,'git-upload-pack','other/project')).status,404);
 assert.equal((await f.humanCredential('GetGitTransport',{ownerId:'2'})).status,404);
 assert.equal((await f.humanCredential('CreateRepository')).status,501);
 assert.equal((await f.humanCredential('GetGitReceiveOutcome',{operationId:crypto.randomUUID()})).status,501);
});

test('Git credentials expire, revoke idempotently and cannot reactivate after grant or identity ABA',async t=>{
 for(const change of ['revoke','expire','grant','identity','artifact']) {
  const f=await credentialsFixture(t),issued=await f.issue(2);
  if(change==='revoke')for(let i=0;i<2;i++) assert.equal((await value(await f.humanCredential('RevokeGitCredential',{credentialId:issued.credential.id}))).revoked,true);
  if(change==='expire')f.sql.exec("UPDATE git_credentials SET created_at=created_at-1800,expires_at=expires_at-1800");
  if(change==='grant')f.sql.exec("DELETE FROM grants WHERE repository_id=1 AND user_id=1; INSERT INTO grants VALUES(1,1,'admin')");
  if(change==='identity')f.sql.exec('UPDATE users SET active=0 WHERE id=1; UPDATE users SET active=1 WHERE id=1');
  if(change==='artifact')f.sql.exec("UPDATE repositories SET artifact_name='replacement' WHERE id=1");
  assert.equal((await f.git(issued.secret)).status,401,change);assert.equal((await f.git(issued.secret,'git-receive-pack','alice/project',push())).status,401,change);
  if(['grant','identity','artifact'].includes(change))assert.equal((await value(await f.humanCredential('ListGitCredentials'))).credentials[0].sourceIdentityActive,false);
 }
});

test('Git credential revocation during provider lookup fences effects and read responses',async t=>{
 for(const write of [true,false]) {
  const f=await credentialsFixture(t),issued=await f.issue(2),get=f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get=async name=>{const repo=await get(name),info=repo.info;repo.info=async()=>{const result=await info();f.sql.exec("UPDATE git_credentials SET revoked_at=CAST(strftime('%s','now') AS INTEGER)");return result;};return repo;};
  const response=await f.git(issued.secret,write?'git-receive-pack':'git-upload-pack','alice/project',write?push():undefined);
  assert.equal(response.status,write?412:401);assert.equal(f.counts().effects,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_operations').get().n,0);assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
 }
});

test('credential creation rejects invalid inputs, bounds allocation and preserves inspectable metadata after lost responses',async t=>{
 const f=await credentialsFixture(t);
 for(const fields of [{label:''},{label:' x'},{label:'x\n'},{label:'x'.repeat(65)},{mode:3},{lifetimeSeconds:299},{lifetimeSeconds:3601},{lifetimeSeconds:1.5}])assert.equal((await f.humanCredential('CreateGitCredential',{label:'work',mode:1,lifetimeSeconds:300,...fields})).status,400);
 const db=f.env.DB.withSession('first-primary');
 f.env.DB.withSession=()=>({...db,prepare:query=>{const statement=db.prepare(query),run=statement.run;statement.run=async()=>{const result=await run();if(query.startsWith('INSERT INTO git_credentials'))throw Error('lost response');return result;};return statement;}});
 assert.equal((await f.humanCredential('CreateGitCredential',{label:'lost',mode:1,lifetimeSeconds:300})).status,503);
 f.env.DB.withSession=()=>db;
 const list=await value(await f.humanCredential('ListGitCredentials'));assert.equal(list.credentials.length,1);assert.equal(list.credentials[0].label,'lost');assert.equal(list.secret,undefined);
 f.sql.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<99) INSERT INTO git_credentials(digest,user_id,repository_id,artifact_name,label,mode,identity_version,grant_generation,created_at,expires_at) SELECT 'fixture-'||x,user_id,repository_id,artifact_name,label,mode,identity_version,grant_generation,created_at,expires_at FROM git_credentials,n WHERE id=1");
 assert.equal((await f.humanCredential('CreateGitCredential',{label:'excess',mode:1,lifetimeSeconds:300})).status,412);
 const paged=await value(await f.humanCredential('ListGitCredentials',{page:{page:1,limit:20}}));assert.equal(paged.credentials.length,20);assert.equal(paged.page.nextPage,2);
 await value(await f.humanCredential('RevokeGitCredential',{credentialId:'1'}));assert.ok((await f.issue()).secret);
});

test('Git credential allocation checks current authority at the durable effect',async t=>{
 const f=await credentialsFixture(t),db=f.env.DB.withSession('first-primary');
 f.env.DB.withSession=()=>({...db,prepare:query=>{const statement=db.prepare(query),run=statement.run;statement.run=async()=>{if(query.startsWith('INSERT INTO git_credentials'))f.sql.exec("DELETE FROM grants WHERE user_id=1; INSERT INTO grants VALUES(1,1,'admin')");return run();};return statement;}});
 assert.equal((await f.humanCredential('CreateGitCredential',{label:'stale',mode:2,lifetimeSeconds:300})).status,412);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_credentials').get().n,0);
});

test('a real Git client answers the Basic challenge and lists refs with a repository read credential',async t=>{
 const {createServer}=await import('node:http'),{mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const f=await credentialsFixture(t);assert.equal((await f.write()).status,200);const issued=await f.issue();
 const directory=await mkdtemp(join(tmpdir(),'golf-git-client-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const askpass=join(directory,'askpass');await writeFile(askpass,'#!/bin/sh\ncase "$1" in *Username*) printf "%s" golf ;; *) printf "%s" "$GOLF_GIT_TEST_SECRET" ;; esac\n',{mode:0o700});
 const server=createServer(async(req,res)=>{try{const response=await f.dispatch(new Request(f.env.PUBLIC_ORIGIN+req.url,{headers:req.headers}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const {stdout}=await promisify(execFile)('git',['-c','credential.helper=','ls-remote','http://127.0.0.1:'+server.address().port+'/git/alice/project.git'],{timeout:10000,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:askpass,GOLF_GIT_TEST_SECRET:issued.secret}});
 assert.ok(stdout.includes(commit+'\trefs/heads/main'));assert.ok(!stdout.includes(issued.secret));
 f.setRefs([['refs/heads/main',commit],['refs/heads/feature','b'.repeat(40)]]);
 f.sql.exec("UPDATE repositories SET default_branch='feature'");
 const {stdout:head}=await promisify(execFile)('git',['-c','credential.helper=','ls-remote','--symref','http://127.0.0.1:'+server.address().port+'/git/alice/project.git','HEAD'],{timeout:10000,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:askpass,GOLF_GIT_TEST_SECRET:issued.secret}});
 assert.ok(head.includes('ref: refs/heads/feature\tHEAD'));assert.ok(head.includes('b'.repeat(40)+'\tHEAD'));

});

test('Git credential creation cannot combine a stale writer role with a new reader grant generation',async t=>{
 const f=await credentialsFixture(t),db=f.env.DB.withSession('first-primary');
 f.env.DB.withSession=()=>({...db,prepare:query=>{const statement=db.prepare(query),first=statement.first;statement.first=async()=>{if(query.startsWith('SELECT generation FROM collaborator_versions'))f.sql.exec("UPDATE grants SET role='read' WHERE user_id=1");return first();};return statement;}});
 assert.equal((await f.humanCredential('CreateGitCredential',{label:'stale writer',mode:2,lifetimeSeconds:300})).status,412);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_credentials').get().n,0);
});

async function nativeReviewFixture(t) {
 const f=await pullFixture(t),pr=f.created.pullRequest;
 f.sql.exec("UPDATE users SET email=login||'@example.com'");
 const target={repository:key,repositoryId:'1',pullRequestId:pr.id,number:pr.number};
 const human=(method,body={},email='alice@example.com')=>f.dispatch(new Request(f.env.PUBLIC_ORIGIN+'/rpc/golf.v1.PullReviewRequestService/'+method,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1',Origin:f.env.PUBLIC_ORIGIN,'X-Golf-Native-Access-Email':email},body:JSON.stringify({...target,...body})}));
 const assignment=async(requestReview=true)=>{const s=await value(await human('GetPullReviewRequests'));return {...target,operationId:nonce(),expectedPullRevision:s.pullRevision,expectedRequestsRevision:s.requestsRevision,reviewerId:'2',reviewerLogin:'bob',...(requestReview?{requestReview:true}:{})};};
 const approval=async()=> (await value(await f.call('CreatePullRequestReview',{...target,expectedRevision:pr.revision,baseCommitId:pr.base.commitId,headCommitId:pr.head.commitId,state:'PULL_REQUEST_REVIEW_STATE_APPROVED',body:'',idempotencyKey:nonce()},readerToken))).review;
 return {...f,target,human,assignment,approval};
}
test('native review assignments use shared receipts, cancel, replay and current readers',async t=>{
 const f=await nativeReviewFixture(t),input=await f.assignment();
 const capabilities=()=>f.call('ListCapabilities',{},ownerToken,'/rpc/golf.v1.CapabilityService/ListCapabilities');
 assert.equal((await value(await capabilities())).capabilities.find(c=>c.id==='pull.pending-reviews').state,'CAPABILITY_STATE_DISABLED');
 f.env.ACCESS_AUD='review-proof';
 assert.equal((await value(await capabilities())).capabilities.find(c=>c.id==='pull.pending-reviews').state,'CAPABILITY_STATE_READY');
 assert.equal((await f.call('GetPullReviewRequests',f.target,ownerToken,'/rpc/golf.v1.PullReviewRequestService/GetPullReviewRequests')).status,404);
 assert.equal((await f.human('GetPullCodeOwners',{})).status,400);
 assert.deepEqual(await value(await f.human('GetPullReviewTeamCandidates')),{teams:[]});
 const assigned=(await value(await f.human('SubmitPullReviewRequest',input))).operation;
 assert.equal(assigned.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.deepEqual((await value(await f.human('GetPullReviewRequests'))).reviewers.map(u=>u.login),['bob']);
 assert.equal((await value(await f.human('GetPullReviewRequests',{},'bob@example.com'))).canManage,false);
 assert.equal((await f.human('SubmitPullReviewRequest',await f.assignment(false),'bob@example.com')).status,404);
 assert.equal((await f.human('SubmitPullReviewRequest',{...input,requestReview:false})).status,409);
 assert.equal((await f.human('SubmitPullReviewRequest',{...input,operationId:nonce(),reviewerTeam:true})).status,400);
 assert.equal((await f.human('GetPullReviewRequestOperation',{operationId:input.operationId,number:99})).status,404);
 const cancel=await f.assignment(false);
 assert.equal((await value(await f.human('SubmitPullReviewRequest',cancel))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.equal((await value(await f.human('GetPullReviewRequests'))).reviewers.length,0);
 assert.deepEqual((await value(await f.human('SubmitPullReviewRequest',input))).operation,assigned);
 assert.equal((await value(await f.human('GetPullReviewRequests'))).reviewers.length,0);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM discussion_events WHERE kind IN ('review_requested','review_request_removed')").get().n,2);
});
test('native review assignment revisions fence cancellation ABA, source change and recipient re-enrollment',async t=>{
 const f=await nativeReviewFixture(t),old=await f.assignment();
 await value(await f.human('SubmitPullReviewRequest',old));
 await value(await f.human('SubmitPullReviewRequest',await f.assignment(false)));
 assert.equal((await value(await f.human('SubmitPullReviewRequest',{...old,operationId:nonce()}))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
 const fresh=await f.assignment();
 f.setRefs([['refs/heads/main',commit],['refs/heads/feature','c'.repeat(40)]]);
 assert.equal((await value(await f.human('SubmitPullReviewRequest',fresh))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
 await value(await f.human('SubmitPullReviewRequest',await f.assignment()));
 f.sql.exec('DELETE FROM grants WHERE user_id=2');
 f.sql.exec("INSERT INTO grants VALUES(1,2,'read')");
 assert.equal((await value(await f.human('GetPullReviewRequests'))).reviewers.length,0);
 await value(await f.human('SubmitPullReviewRequest',await f.assignment()));
 f.sql.exec('UPDATE users SET active=0 WHERE id=2; UPDATE users SET active=1 WHERE id=2');
 assert.equal((await value(await f.human('GetPullReviewRequests'))).reviewers.length,0);
});
test('native review dismissal/restoration binds exact review revisions and keeps historical receipts',async t=>{
 const f=await nativeReviewFixture(t),r=await f.approval(),selection={reviewId:r.id,reviewCommitId:r.commitId};
 let s=await value(await f.human('GetPullReviewLifecycleState',selection));
 const input={...selection,expectedPullRevision:s.pullRevision,expectedReviewRevision:s.reviewRevision,operationId:nonce(),dismiss:true,reason:'New review required',reasonHash:await digest('New review required')};
 assert.equal((await f.human('SubmitPullReviewLifecycle',input,'bob@example.com')).status,404);
 assert.equal((await f.human('SubmitPullReviewLifecycle',{...input,reason:'Changed'})).status,400);
 const dismissed=(await value(await f.human('SubmitPullReviewLifecycle',input))).operation;
 assert.equal(dismissed.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');assert.equal(dismissed.original.reason,undefined);
 assert.equal((await value(await f.call('ListPullRequestReviews',{repository:key,number:1}))).reviews[0].dismissed,true);
 s=await value(await f.human('GetPullReviewLifecycleState',selection));assert.equal(s.canRestore,true);
 const restore={...selection,expectedPullRevision:s.pullRevision,expectedReviewRevision:s.reviewRevision,operationId:nonce()};
 assert.equal((await value(await f.human('SubmitPullReviewLifecycle',restore))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.equal((await value(await f.human('SubmitPullReviewLifecycle',{...input,operationId:nonce()}))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
 assert.deepEqual((await value(await f.human('SubmitPullReviewLifecycle',input))).operation,dismissed);
 assert.equal((await value(await f.human('GetPullReviewLifecycleState',selection))).review.dismissed,false);
 assert.equal((await f.human('GetPullReviewLifecycleOperation',{operationId:input.operationId,pullRequestId:'99'})).status,404);
 f.sql.exec('UPDATE users SET active=0 WHERE id=1');
 assert.equal((await f.human('GetPullReviewLifecycleOperation',{operationId:input.operationId})).status,401);
});
test('native dismissal never restores stale, superseded or inaccessible-author reviews',async t=>{
 const f=await nativeReviewFixture(t),r=await f.approval(),selection={reviewId:r.id,reviewCommitId:r.commitId};
 let s=await value(await f.human('GetPullReviewLifecycleState',selection));
 await value(await f.human('SubmitPullReviewLifecycle',{...selection,expectedPullRevision:s.pullRevision,expectedReviewRevision:s.reviewRevision,operationId:nonce(),dismiss:true,reason:'Again',reasonHash:await digest('Again')}));
 f.setRefs([['refs/heads/main',commit],['refs/heads/feature','c'.repeat(40)]]);
 s=await value(await f.human('GetPullReviewLifecycleState',selection));assert.equal(s.canRestore,false);assert.equal(s.review.stale,true);
 assert.equal((await value(await f.human('SubmitPullReviewLifecycle',{...selection,expectedPullRevision:s.pullRevision,expectedReviewRevision:s.reviewRevision,operationId:nonce()}))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
 f.setRefs([['refs/heads/main',commit],['refs/heads/feature','b'.repeat(40)]]);
 f.sql.exec('UPDATE users SET active=0 WHERE id=2');
 assert.equal((await value(await f.human('GetPullReviewLifecycleState',selection))).canRestore,false);
 f.sql.exec('UPDATE users SET active=1 WHERE id=2');await f.approval();
 assert.equal((await value(await f.human('GetPullReviewLifecycleState',selection))).canRestore,false);
});
test('native review transaction loses authority safely and recovers lost acknowledgement without duplicate events',async t=>{
 const f=await nativeReviewFixture(t),input=await f.assignment(),batch=f.env.DB.batch;
 f.env.DB.batch=async statements=>{const r=await batch(statements);throw Error('Lost acknowledgement');};
 assert.equal((await f.human('SubmitPullReviewRequest',input)).status,503);
 f.env.DB.batch=batch;
 assert.equal((await value(await f.human('GetPullReviewRequestOperation',{operationId:input.operationId}))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 await value(await f.human('SubmitPullReviewRequest',input));
 assert.equal(f.sql.prepare("SELECT count(*) n FROM discussion_events WHERE kind='review_requested'").get().n,1);
 const cancel=await f.assignment(false);
 f.env.DB.batch=async statements=>{f.sql.exec("UPDATE grants SET role='read' WHERE user_id=1; UPDATE grants SET role='admin' WHERE user_id=1");return batch(statements);};
 assert.equal((await f.human('SubmitPullReviewRequest',cancel)).status,404);
 f.env.DB.batch=batch;
 assert.equal((await value(await f.human('GetPullReviewRequestOperation',{operationId:cancel.operationId}))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
 assert.equal((await value(await f.human('GetPullReviewRequests'))).reviewers.length,1);
});

async function nativeAuthoringFixture(t) {
 const f=await nativeReviewFixture(t);
 const author=(method,body={},email='bob@example.com')=>f.dispatch(new Request(f.env.PUBLIC_ORIGIN+'/rpc/golf.v1.PullReviewAuthoringService/'+method,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1',Origin:f.env.PUBLIC_ORIGIN,'X-Golf-Native-Access-Email':email},body:JSON.stringify({target:f.target,...body})}));
 const prepare=async(kind,body='Private summary',decision=0,email='bob@example.com')=>{const s=await value(await author('GetPullReviewAuthoringState',{},email));return {target:f.target,kind,operationId:nonce(),expectedPullRevision:s.pullRevision,expectedSnapshotRevision:s.snapshotRevision,...(kind===1?{}:{reviewId:s.review?.id,reviewCommitId:s.review?.commitId}),...(kind===5?{}:{body,bodyHash:await digest(body)}),...(decision?{decision}:{})};};
 return {...f,author,prepare};
}
test('native pending review summaries stay private, publish once, and expose original outcomes',async t=>{
 const f=await nativeAuthoringFixture(t),draft=await f.prepare(1);
 assert.equal((await f.author('SubmitPullReviewAuthoringOperation',{...draft,body:false})).status,400);
 const created=(await value(await f.author('SubmitPullReviewAuthoringOperation',draft))).operation;
 assert.equal(created.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');assert.equal(created.original.body,undefined);assert.equal(created.observedReviewId,'1');
 const state=await value(await f.author('GetPullReviewAuthoringState'));
 assert.equal(state.review.state,'PULL_REQUEST_REVIEW_STATE_PENDING');assert.equal(state.review.body,'Private summary');assert.equal(state.canCreate,false);assert.equal(state.canUpdate,true);
 assert.equal((await value(await f.call('ListPullRequestReviews',{repository:key,number:1}))).reviews.length,0);
 assert.equal((await value(await f.call('ListPullRequestReviews',{repository:key,number:1},readerToken))).reviews[0].state,'PULL_REQUEST_REVIEW_STATE_PENDING');
 assert.equal((await f.human('GetPullReviewLifecycleState',{reviewId:state.review.id,reviewCommitId:state.review.commitId})).status,404);
 assert.equal((await f.author('GetPullReviewAuthoringState',{reviewId:state.review.id,reviewCommitId:state.review.commitId},'alice@example.com')).status,404);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM discussion_events WHERE kind LIKE 'review_%'").get().n,0);
 const edit=await f.prepare(3,'Revised private summary');await value(await f.author('SubmitPullReviewAuthoringOperation',edit));
 assert.equal((await value(await f.author('GetPullReviewAuthoringState'))).review.body,'Revised private summary');
 assert.equal((await value(await f.author('SubmitPullReviewAuthoringOperation',{...edit,operationId:nonce(),body:'Stale edit',bodyHash:await digest('Stale edit')}))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
 const submit=await f.prepare(4,'',1),published=(await value(await f.author('SubmitPullReviewAuthoringOperation',submit))).operation;
 assert.equal(published.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 const reviews=(await value(await f.call('ListPullRequestReviews',{repository:key,number:1}))).reviews;
 assert.equal(reviews[0].id,created.observedReviewId);assert.equal(reviews[0].state,'PULL_REQUEST_REVIEW_STATE_APPROVED');assert.equal(reviews[0].body,'');
 assert.equal(f.sql.prepare("SELECT count(*) n FROM discussion_events WHERE kind='review_approved'").get().n,1);
 assert.deepEqual((await value(await f.author('SubmitPullReviewAuthoringOperation',submit))).operation,published);
 assert.deepEqual((await value(await f.author('GetPullReviewAuthoringOperation',{operationId:draft.operationId}))).operation,created);
 assert.equal((await value(await f.author('GetPullReviewAuthoringState'))).canCreate,true);
});
test('native pending reviews reject stale source, author approval and unsupported inline intents; discarded text stays absent',async t=>{
 const f=await nativeAuthoringFixture(t),first=await f.prepare(1);await value(await f.author('SubmitPullReviewAuthoringOperation',first));
 const pending=await value(await f.author('GetPullReviewAuthoringState'));
 assert.equal((await f.author('SubmitPullReviewAuthoringOperation',{...await f.prepare(3),commentId:'9'})).status,400);
 f.setRefs([['refs/heads/main',commit],['refs/heads/feature','c'.repeat(40)]]);
 let s=await value(await f.author('GetPullReviewAuthoringState'));assert.equal(s.canSubmit,false);assert.equal(s.canUpdate,false);assert.equal(s.canDiscard,true);
 assert.equal((await value(await f.author('SubmitPullReviewAuthoringOperation',await f.prepare(4,'Approve',1)))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
 const discard=await f.prepare(5);assert.equal((await value(await f.author('SubmitPullReviewAuthoringOperation',discard))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.equal((await value(await f.call('ListPullRequestReviews',{repository:key,number:1},readerToken))).reviews.length,0);
 assert.equal(f.sql.prepare('SELECT body FROM pull_reviews WHERE id=?').get(Number(pending.review.id)).body,'');
 assert.equal((await f.author('GetPullReviewAuthoringState',{reviewId:pending.review.id,reviewCommitId:pending.review.commitId})).status,404);
 const next=await f.prepare(1,'Author private',0,'alice@example.com');await value(await f.author('SubmitPullReviewAuthoringOperation',next,'alice@example.com'));
 assert.equal((await value(await f.author('SubmitPullReviewAuthoringOperation',await f.prepare(4,'Self approval',1,'alice@example.com'),'alice@example.com'))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
 assert.equal((await value(await f.author('SubmitPullReviewAuthoringOperation',await f.prepare(4,'Author comment',3,'alice@example.com'),'alice@example.com'))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 // Creation/discard must not make the old no-draft revision current again.
 const stale={...first,operationId:nonce()};assert.equal((await value(await f.author('SubmitPullReviewAuthoringOperation',stale))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_REJECTED');
});
test('native pending review effects and receipts commit together and private drafts do not emit live invalidations',async t=>{
 const f=await nativeAuthoringFixture(t),draft=await f.prepare(1),batch=f.env.DB.batch;
 f.env.DB.batch=async statements=>{await batch(statements);throw Error('lost');};
 assert.equal((await f.author('SubmitPullReviewAuthoringOperation',draft)).status,503);f.env.DB.batch=batch;
 assert.equal((await value(await f.author('GetPullReviewAuthoringOperation',{operationId:draft.operationId}))).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.equal((await f.author('GetPullReviewAuthoringOperation',{operationId:draft.operationId},'alice@example.com')).status,404);
 const edit=await f.prepare(3,'Changed');
 f.env.DB.batch=async statements=>{f.sql.exec('DELETE FROM grants WHERE user_id=2');return batch(statements);};
 assert.equal((await f.author('SubmitPullReviewAuthoringOperation',edit)).status,404);
 assert.equal(f.sql.prepare('SELECT body FROM pull_reviews').get().body,'Private summary');f.env.DB.batch=batch;
 const {activitySelection}=await import('./src/activity.mjs');
 const event=kind=>new Request('https://golf.example.com/rpc/golf.v1.PullReviewAuthoringService/SubmitPullReviewAuthoringOperation',{method:'POST',body:JSON.stringify({target:f.target,kind})});
 assert.equal(await activitySelection(event(1)),undefined);
 assert.equal(await activitySelection(event(3)),undefined);
 assert.deepEqual(await activitySelection(event(4)),{name:'project',id:'1',topics:['pulls']});
});

test('requested reviewers receive an inbox item without subscribing; published reviews complete the request',async t=>{
 const f=await nativeAuthoringFixture(t);
 await value(await f.human('SubmitPullReviewRequest',await f.assignment()));
 assert.equal(f.sql.prepare('SELECT count(*) n FROM discussion_notifications WHERE user_id=2').get().n,1);
 await value(await f.author('SubmitPullReviewAuthoringOperation',await f.prepare(1)));
 assert.equal((await value(await f.human('GetPullReviewRequests'))).reviewers.length,1);
 await value(await f.author('SubmitPullReviewAuthoringOperation',await f.prepare(4,'Finished',3)));
 assert.equal((await value(await f.human('GetPullReviewRequests'))).reviewers.length,0);
 await value(await f.human('SubmitPullReviewRequest',await f.assignment()));await f.approval();
 assert.equal((await value(await f.human('GetPullReviewRequests'))).reviewers.length,0);
});

test('native CODEOWNERS reads the base branch file, honors precedence, and refuses stale source and revoked access',async t=>{
 const f=await nativeReviewFixture(t),pr=f.created.pullRequest,source='*.txt @bob\n',blob='d'.repeat(40),root='e'.repeat(40),github='f'.repeat(40),headTree='1'.repeat(40);
 const get=f.env.ARTIFACTS.get;let touchedHeadRules=false;
 f.env.ARTIFACTS.get=async name=>{const repo=await get(name);return {...repo,
  async readCommit(hash){return {hash,treeHash:hash===commit?root:headTree,parents:hash===commit?[]:[commit]};},
  async readTree(hash){if(hash===github)return [{name:'CODEOWNERS',hash:blob,type:'blob',mode:'100644'}];return [{name:'.github',hash:github,type:'tree',mode:'040000'},{name:'CODEOWNERS',hash:'9'.repeat(40),type:'blob',mode:'100644'},{name:'hello.txt',hash:hash===root?'2'.repeat(40):'3'.repeat(40),type:'blob',mode:'100644'}];},
  async readBlob(hash){if(hash!=='d'.repeat(40))touchedHeadRules=true;return new Blob([source]);}
 };};
 const selected={repository:key,repositoryId:'1',pullRequestId:pr.id,number:pr.number,baseCommitId:commit,headCommitId:pr.head.commitId};
 const input={selection:selected,expectedPullRevision:pr.revision};
 assert.equal((await f.human('GetPullCodeOwners',{...input,selection:{...selected,repository:{owner:'alice',name:'other'}}})).status,404);
 const result=await value(await f.human('GetPullCodeOwners',input));
 assert.equal(result.path,'.github/CODEOWNERS');assert.equal(result.blobId,blob);assert.deepEqual(result.matches,[{path:'hello.txt',owners:['@bob']}]);assert.equal(touchedHeadRules,false);
 assert.equal((await f.human('GetPullCodeOwners',{...input,expectedPullRevision:'0'.repeat(64)})).status,412);
 f.setRefs([['refs/heads/main',commit],['refs/heads/feature','4'.repeat(40)]]);
 assert.equal((await f.human('GetPullCodeOwners',input)).status,412);
 f.setRefs([['refs/heads/main',commit],['refs/heads/feature',pr.head.commitId]]);
 f.env.ARTIFACTS.get=async name=>{f.sql.exec("DELETE FROM grants WHERE user_id=1");return get(name);};
 assert.equal((await f.human('GetPullCodeOwners',input)).status,404);
});

test('native default branch changes verify real refs and atomically update settings with source identity',async t=>{
 const f=await pullFixture(t),call=(method,body={})=>f.call(method,{repository:key,...body},ownerToken,'/rpc/golf.v1.RepositorySettingsService/'+method);
 const original=(await value(await call('GetRepositorySettings'))).settings;
 const target={repositoryId:'1',ownerId:original.ownerId,expectedRevision:original.revision};
 assert.equal((await call('UpdateRepositorySettings',{...target,defaultBranch:'missing'})).status,412);
 for(const name of ['', '../feature','feature.lock','refs/heads/../main']) assert.equal((await call('UpdateRepositorySettings',{...target,defaultBranch:name})).status,400);
 const result=(await value(await call('UpdateRepositorySettings',{...target,description:'Chosen feature',defaultBranch:'feature'}))).settings;
 assert.equal(result.defaultBranch,'feature');assert.equal(result.description,'Chosen feature');assert.notEqual(result.revision,original.revision);
 assert.equal(f.sql.prepare('SELECT default_branch FROM repositories').get().default_branch,'feature');
 assert.equal((await call('UpdateRepositorySettings',{...target,defaultBranch:'main'})).status,412);
 assert.equal((await value(await f.call('GetRepository',{repository:key}))).repository.defaultBranch,'feature');
 f.sql.exec("UPDATE repositories SET write_pending='unresolved'");
 assert.equal((await call('UpdateRepositorySettings',{...target,expectedRevision:result.revision,defaultBranch:'main'})).status,412);
 assert.equal(f.sql.prepare('SELECT default_branch FROM repositories').get().default_branch,'feature');
});
test('native general settings fence role/identity/credential loss and default-branch races inside D1',async t=>{
 for(const mutation of ["UPDATE grants SET role='read' WHERE user_id=1",'UPDATE users SET active=0 WHERE id=1','UPDATE credentials SET revoked=1 WHERE user_id=1',"UPDATE repositories SET default_branch='other' WHERE id=1"]) await t.test(mutation,async t=>{
  const f=await pullFixture(t),call=(method,body={})=>f.call(method,{repository:key,...body},ownerToken,'/rpc/golf.v1.RepositorySettingsService/'+method);
  const before=(await value(await call('GetRepositorySettings'))).settings,batch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{f.sql.exec(mutation);return batch(statements);};
  const r=await call('UpdateRepositorySettings',{repositoryId:'1',ownerId:before.ownerId,expectedRevision:before.revision,description:'Must not apply',defaultBranch:'feature'});
  assert.equal(r.status,412);assert.equal(f.sql.prepare('SELECT count(*) n FROM repository_settings').get().n,0);
  assert.notEqual(f.sql.prepare('SELECT default_branch FROM repositories').get().default_branch,'feature');
 });
});

test('complete file inventory is immutable, indexed and current-authority fenced', async t => {
 const f=await evidenceFixture(t);await f.sendPush();f.env.READ_INDEXES='true';
 const target={repository:key,repositoryId:'1',commitId:commit};
 let response=await f.call('GetRepositoryFileIndex',target);
 assert.equal(response.status,200);const inventory=await response.json();assert.deepEqual(inventory,{repositoryId:'1',commitId:commit,paths:['hello.txt','link']});
 assert.equal(f.sql.prepare('SELECT state FROM repository_indexes').get().state,'READY');
 f.env.ARTIFACTS.get=async()=>{throw Error('Warm file inventory must avoid Artifacts reads');};
 assert.deepEqual(await value(await f.call('GetRepositoryFileIndex',target)),inventory);
 assert.equal((await f.call('GetRepositoryFileIndex',{...target,commitId:'main'})).status,400);
 assert.equal((await f.call('GetRepositoryFileIndex',{...target,repositoryId:'2'})).status,404);
 f.env.confirmRead=async()=>deny();
 response=await f.call('GetRepositoryFileIndex',target);assert.equal(response.status,404);assert.ok(!(await response.text()).includes('hello.txt'));
 delete f.env.confirmRead;
 f.sql.prepare('DELETE FROM grants WHERE repository_id=1').run();
 assert.equal((await f.call('GetRepositoryFileIndex',target)).status,404);
});

test('native merge diagnostics bind live source, locks, base ancestry and current readers', async t => {
  const f=await evidenceFixture(t), pr=f.created.pullRequest;
  const input={selection:f.selection,expectedPullRevision:pr.revision};
  const read=(body=input,token=ownerToken)=>f.call('',body,token,'/rpc/golf.v1.PullMergeObservationService/GetPullRequestMergeObservation');
  const initial=(await value(await read())).observation;
  assert.equal(initial.targetProtection,'PULL_MERGE_TARGET_PROTECTION_UNPROTECTED');
  assert.equal(initial.sourceState,'PULL_MERGE_SOURCE_STATE_CURRENT');
  assert.equal(initial.nativeCallerCanMerge,true);
  assert.equal(initial.currentTargetWriter,true);
  assert.equal(initial.unavailableReason,'protected_integration_unqualified');
  assert.deepEqual(initial.mergeConfiguration,{allowMergeCommits:true,allowSquashMerge:true,defaultMergeStyle:'merge',defaultUpdateStyle:'merge'});
  const reader=(await value(await read(input,readerToken))).observation;
  assert.equal(reader.currentTargetWriter,false);assert.equal(reader.nativeCallerCanMerge,false);assert.equal(Object.values(reader.mergeConfiguration).some(v=>v===true),false);
  assert.equal((await read({...input,expectedPullRevision:'0'.repeat(64)})).status,412);
  assert.equal((await read({...input,selection:{...f.selection,repositoryId:'9'}})).status,404);
  const artifact=f.sql.prepare('SELECT artifact_name FROM repositories WHERE id=1').get().artifact_name;
  f.sql.prepare('INSERT INTO repository_rules(repository_id,artifact_name,version,branches,tags,next_tag) VALUES(1,?,1,?,\'[]\',1)').run(artifact,JSON.stringify([{ruleName:'main'}]));
  const locked=(await value(await read())).observation;
  assert.equal(locked.targetProtection,'PULL_MERGE_TARGET_PROTECTION_PROTECTED');assert.notEqual(locked.fingerprint,initial.fingerprint);
  assert.equal(locked.nativeCallerCanMerge,false);assert.equal(Object.values(locked.mergeConfiguration).some(v=>v===true),false);
  f.setRefs([['refs/heads/main',pr.base.commitId]]);
  const retained=(await value(await read())).observation;
  assert.equal(retained.sourceState,'PULL_MERGE_SOURCE_STATE_RETAINED_ONLY');assert.equal(retained.source,undefined);assert.equal(retained.sourceRepository,undefined);
  f.sql.exec('DELETE FROM grants WHERE user_id=2');assert.equal((await read(input,readerToken)).status,404);
});

async function mergeFixture(t) {
  const f=await pullFixture(t), pr=f.created.pullRequest;
  const selection={repository:key,repositoryId:'1',pullRequestId:pr.id,number:pr.number,baseCommitId:pr.base.commitId,headCommitId:pr.head.commitId};
  const input=(changes={})=>({selection,ownerId:'1',expectedPullRevision:pr.revision,operationId:nonce(),sourceRef:'feature',targetRef:'main',...changes});
  const submit=(body,token)=>f.call('',body,token,'/rpc/golf.v1.StandardPullMergeService/SubmitStandardPullMerge');
  const inspect=(body,token,changes={})=>f.call('',{repository:key,repositoryId:'1',ownerId:'1',pullRequestId:pr.id,number:pr.number,operationId:body.operationId,...changes},token,'/rpc/golf.v1.StandardPullMergeService/GetStandardPullMergeOperation');
  const observe=(pull=pr,token)=>f.call('',{selection:{...selection,baseCommitId:pull.base.commitId,headCommitId:pull.head.commitId},expectedPullRevision:pull.revision},token,'/rpc/golf.v1.PullMergeObservationService/GetPullRequestMergeObservation');
  const pull=async()=>(await value(await f.call('GetPullRequest',{repository:key,number:pr.number}))).pullRequest;
  const journal=()=>f.sql.prepare('SELECT * FROM pull_merge_operations ORDER BY created_at,rowid').all();
  return {...f,pr,selection,input,submit,inspect,observe,pull,journal};
}
const mergePhase=name=>'STANDARD_PULL_MERGE_PHASE_'+name;

test('native merge writes one verified merge commit through the push journal and keeps its original receipt', async t => {
  const f=await mergeFixture(t), body=f.input({commitTitle:'Merge feature',commitMessage:'Reviewed by the team.\n'});
  f.sql.prepare("UPDATE users SET full_name='Alice <Admin>' WHERE id=1").run();
  assert.equal((await value(await f.observe())).observation.nativeCallerCanMerge,true);
  const operation=(await value(await f.submit(body))).operation, merge=operation.mergeCommitId;
  assert.deepEqual(Object.keys(operation).sort(),['actorId','actualBaseCommitId','contract','createdAt','expectedPullRevision','failureCode','headCommitId','mergeCommitId','method','number','observedBaseCommitId','operationId','ownerId','phase','pullRequestId','repository','repositoryId','sourceRef','targetRef','updatedAt']);
  assert.deepEqual({...operation,mergeCommitId:'',createdAt:'',updatedAt:''},{operationId:body.operationId,actorId:'1',repository:key,repositoryId:'1',ownerId:'1',pullRequestId:f.pr.id,number:f.pr.number,
    expectedPullRevision:f.pr.revision,headCommitId:'b'.repeat(40),observedBaseCommitId:commit,sourceRef:'feature',targetRef:'main',method:'merge',phase:mergePhase('SUCCEEDED'),
    mergeCommitId:'',actualBaseCommitId:commit,failureCode:'',createdAt:'',updatedAt:'',contract:'golf.pull.standard-native-merge.v1'});
  assert.match(merge,/^[a-f0-9]{40}$/);assert.ok(Date.parse(operation.updatedAt)>=Date.parse(operation.createdAt));
  // The fixture provider decoded the pack independently and stored exactly the commit whose ID the Worker computed.
  const artifact=f.sql.prepare('SELECT artifact_name FROM repositories WHERE id=1').get().artifact_name, stored=await (await f.env.ARTIFACTS.get(artifact)).readCommit(merge);
  assert.deepEqual(stored,{hash:merge,treeHash:'f'.repeat(40),parents:[commit,'b'.repeat(40)],message:'Merge feature\n\nReviewed by the team.\n',
    author:{name:'Alice Admin',email:'alice@users.noreply.golf.example.com'},authoredAt:Math.floor(Date.parse(operation.createdAt)/1000)});
  assert.equal(f.counts().effects,1);assert.equal(f.tokens.size,0);
  assert.deepEqual({...f.sql.prepare('SELECT repository_id,user_id,ref,old_sha,new_sha,state,ci_state FROM git_operations').get()},{repository_id:1,user_id:1,ref:'refs/heads/main',old_sha:commit,new_sha:merge,state:'APPLIED',ci_state:'NONE'});
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
  // Title and message are in the fingerprint and the commit only.
  assert.doesNotMatch(JSON.stringify(f.journal()),/Reviewed|Merge feature/);
  assert.deepEqual((await value(await f.submit(body))).operation,operation);
  assert.deepEqual((await value(await f.inspect(body))).operation,operation);
  assert.equal((await f.submit({...body,commitMessage:'Different text'})).status,412);
  assert.equal((await f.inspect(body,ownerToken,{number:f.pr.number+1})).status,404);
  assert.equal(f.counts().effects,1);assert.equal(f.journal().length,1);
  // The merged proposal is closed, records its commit and keeps the merged comparison although main moved.
  const merged=await f.pull();
  assert.equal(merged.merged,true);assert.equal(merged.state,'ISSUE_STATE_CLOSED');assert.equal(merged.mergeCommitId,merge);assert.equal(merged.mergedAt,operation.updatedAt);
  assert.equal(merged.base.commitId,commit);assert.equal(merged.head.commitId,'b'.repeat(40));assert.equal(merged.mergeBaseCommitId,commit);assert.equal(merged.base.retainedSnapshot,true);
  assert.equal((await value(await f.call('ListBranches',{repository:key}))).branches.find(branch=>branch.name==='main').commitId,merge);
  const compared={...f.selection,baseCommitId:merged.base.commitId,headCommitId:merged.head.commitId};
  assert.equal((await value(await f.call('GetPullRequestDiff',compared))).mergeBaseCommitId,commit);
  assert.deepEqual((await value(await f.call('ListPullRequestCommits',{selection:compared}))).commits.map(c=>c.sha),['b'.repeat(40)]);
  assert.equal((await value(await f.call('ListPullRequests',{repository:key}))).pullRequests.length,0);
  assert.equal((await value(await f.call('ListPullRequests',{repository:key,state:'ISSUE_STATE_CLOSED'}))).pullRequests[0].mergeCommitId,merge);
  assert.deepEqual(f.sql.prepare("SELECT kind FROM discussion_events WHERE kind IN ('merge_pull','close')").all().map(e=>e.kind),['merge_pull']);
  // A merged proposal is never reopened, drafted or merged again.
  const edit=changes=>f.call('UpdatePullRequest',{repository:key,repositoryId:'1',pullRequestId:merged.id,number:merged.number,expectedRevision:merged.revision,idempotencyKey:nonce(),...changes});
  assert.equal((await edit({state:'ISSUE_STATE_OPEN'})).status,412);assert.equal((await edit({draft:true})).status,412);
  assert.equal((await f.pull()).state,'ISSUE_STATE_CLOSED');
  const again=(await value(await f.submit(f.input({selection:compared,expectedPullRevision:merged.revision})))).operation;
  assert.equal(again.phase,mergePhase('REJECTED'));assert.equal(again.failureCode,'preflight_refused');assert.equal(f.journal()[1].detail,'pull_request_not_open');
  assert.equal(f.counts().effects,1);
  assert.equal((await value(await f.call('',{},ownerToken,'/native/diagnostics'))).schema,54);
  const capability=(await value(await f.call('',{},ownerToken,'/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.filter(c=>c.id==='pull.merge');
  assert.equal(capability.length,1);assert.equal(capability[0].state,'CAPABILITY_STATE_READY');
});

test('native merge refuses everything outside its slice with a durable receipt and no provider write', async t => {
  const f=await mergeFixture(t), refused=async(body,detail)=>{
    const operation=(await value(await f.submit(body))).operation, row=f.journal().at(-1);
    assert.equal(operation.phase,mergePhase('REJECTED'));assert.equal(operation.failureCode,'preflight_refused');assert.equal(operation.refusalCode,detail);assert.equal(operation.mergeCommitId,'');assert.equal(operation.actualBaseCommitId,'');
    assert.equal(row.operation_id,body.operationId);assert.equal(row.detail,detail);assert.equal(row.git_operation_id,null);
    assert.deepEqual((await value(await f.inspect(body))).operation,operation);
    return operation;
  };
  const fork={sourceRepository:{owner:'bob',name:'fork'},sourceRepositoryId:'7',sourceOwnerId:'2'}, forked=await refused(f.input(fork),'fork_source_unsupported');
  assert.equal(forked.contract,'golf.pull.standard-native-merge.v2');assert.deepEqual(forked.sourceRepository,fork.sourceRepository);assert.equal(forked.sourceRepositoryId,'7');assert.equal(forked.sourceOwnerId,'2');
  await refused(f.input({expectedPullRevision:'0'.repeat(64)}),'pull_request_changed');
  await refused(f.input({sourceRef:'other'}),'pull_request_changed');
  const artifact=f.sql.prepare('SELECT artifact_name FROM repositories WHERE id=1').get().artifact_name;
  f.sql.prepare('INSERT INTO repository_rules(repository_id,artifact_name,version,branches,tags,next_tag) VALUES(1,?,1,?,\'[]\',1)').run(artifact,JSON.stringify([{ruleName:'main'}]));
  await refused(f.input(),'target_locked');
  f.sql.exec('DELETE FROM repository_rules');
  // A criss-cross history has two merge bases: no single three-way merge is proven, so nothing is guessed.
  const [x1,x2,m1,m2]=['a1','a2','a3','a4'].map(p=>p.repeat(20)), graph={[x1]:[commit],[x2]:[commit],[m1]:[x1,x2],[m2]:[x2,x1]}, get=f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get=async name=>{const repo=await get(name);return {...repo,async readCommit(hash){return graph[hash]?{hash,treeHash:'f'.repeat(40),parents:graph[hash],message:'Criss-cross',author:{name:'Bob'},authoredAt:1700000001}:repo.readCommit(hash);}};};
  f.setRefs([['refs/heads/main',m1],['refs/heads/feature',m2]]);
  const crossed=await f.pull(), observed=(await value(await f.observe(crossed))).observation;
  assert.equal(observed.nativeCallerCanMerge,false);assert.equal(observed.unavailableReason,'native_ancestry_unproven');assert.equal(Object.values(observed.mergeConfiguration).some(v=>v===true),false);
  for(const method of ['merge','squash']) await refused(f.input({method,selection:{...f.selection,baseCommitId:m1,headCommitId:m2},expectedPullRevision:crossed.revision}),'ancestry_unproven');
  // The base already contains the head: nothing to merge or squash.
  f.setRefs([['refs/heads/main','c'.repeat(40)],['refs/heads/feature','b'.repeat(40)]]);
  const ahead=await f.pull();
  assert.equal((await value(await f.observe(ahead))).observation.unavailableReason,'native_nothing_to_merge');
  for(const method of ['merge','squash']) await refused(f.input({method,selection:{...f.selection,baseCommitId:'c'.repeat(40)},expectedPullRevision:ahead.revision}),'nothing_to_merge');
  f.setRefs([['refs/heads/main',commit],['refs/heads/feature','b'.repeat(40)]]);
  const drafted=(await value(await f.call('UpdatePullRequest',{repository:key,repositoryId:'1',pullRequestId:f.pr.id,number:f.pr.number,expectedRevision:f.pr.revision,idempotencyKey:nonce(),draft:true}))).pullRequest;
  await refused(f.input({expectedPullRevision:drafted.revision}),'pull_request_draft');
  // Malformed intents are invalid before any journal row.
  const rows=f.journal().length;
  for(const invalid of [{method:'rebase'},{sourceRef:'main'},{commitTitle:' padded '},{commitMessage:'bell\x07'},{operationId:'not-a-uuid'},{sourceRepositoryId:'7'},{targetRef:'refs/heads/main'}]) assert.equal((await f.submit(f.input(invalid))).status,400,JSON.stringify(invalid));
  assert.equal(f.journal().length,rows);
  assert.equal(f.counts().effects,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_operations').get().n,0);assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
  assert.equal((await f.pull()).merged,false);
  // A refusal is terminal for its own key only; a fresh eligible request still merges.
  const ready=(await value(await f.call('UpdatePullRequest',{repository:key,repositoryId:'1',pullRequestId:f.pr.id,number:f.pr.number,expectedRevision:drafted.revision,idempotencyKey:nonce(),draft:false}))).pullRequest;
  assert.equal((await value(await f.submit(f.input({expectedPullRevision:ready.revision})))).operation.phase,mergePhase('SUCCEEDED'));
  assert.equal(f.counts().effects,1);
});

test('native merge requires the current writer and never reveals another account\'s receipt', async t => {
  const f=await mergeFixture(t), body=f.input();
  // The reader holds a read grant; a merge is denied like a push, without a journal row.
  assert.equal((await f.submit(body,readerToken)).status,404);
  assert.equal((await f.submit(f.input({ownerId:'9'}))).status,404);
  assert.equal((await f.submit(f.input({selection:{...f.selection,pullRequestId:'99'}}))).status,404);
  assert.equal((await f.submit(f.input({selection:{...f.selection,repositoryId:'9'}}))).status,404);
  assert.equal(f.journal().length,0);assert.equal(f.counts().effects,0);
  f.sql.exec("UPDATE repositories SET write_pending='unresolved'");
  assert.equal((await f.submit(f.input())).status,412);assert.equal(f.journal().length,0);
  f.sql.exec('UPDATE repositories SET write_pending=NULL');
  const operation=(await value(await f.submit(body))).operation;
  assert.equal(operation.phase,mergePhase('SUCCEEDED'));
  await value(await f.call('',{...f.grant,role:'write'},ownerToken,'/native/repository-grant'));
  assert.equal((await f.inspect(body,readerToken)).status,404);
  assert.equal((await value(await f.submit(body,readerToken))).operation.phase,mergePhase('REJECTED'));
  assert.equal(f.journal()[1].actor_id,2);assert.equal(f.journal()[1].detail,'pull_request_changed');
  // Losing write authority hides the caller's own historical receipt.
  f.sql.prepare("UPDATE grants SET role='read' WHERE user_id=1").run();
  assert.equal((await f.inspect(body)).status,404);assert.equal((await f.submit(body)).status,404);
  assert.equal(f.counts().effects,1);
});

test('an unconfirmed native merge stays unknown, fences writes and settles only by reading the ref back', async t => {
  const f=await mergeFixture(t), body=f.input(); f.losePush();
  const first=await f.submit(body), text=await first.clone().text(), unknown=(await value(first)).operation;
  assert.doesNotMatch(text,/sensitive/);
  assert.equal(unknown.phase,mergePhase('DISPATCH_UNKNOWN'));assert.equal(unknown.failureCode,'');assert.equal(unknown.mergeCommitId,'');assert.equal(unknown.actualBaseCommitId,'');
  const git=f.sql.prepare('SELECT * FROM git_operations').get();
  assert.equal(git.state,'DISPATCHED');assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,git.id);
  assert.equal(f.journal()[0].detail,'provider_unavailable');assert.equal(f.journal()[0].git_operation_id,git.id);assert.equal(f.tokens.size,0);
  // Replay, inspection and a second operation never send the pack again.
  assert.deepEqual((await value(await f.submit(body))).operation,unknown);
  assert.deepEqual((await value(await f.inspect(body))).operation,unknown);
  assert.equal((await f.submit(f.input())).status,412);assert.match(await refusal(await f.sendPush()),/finishing a merge/);
  assert.equal(f.journal().length,1);assert.equal(f.counts().effects,1);
  // Clearing the repository fence by hand does not make the pull request mergeable again.
  f.sql.exec('UPDATE repositories SET write_pending=NULL');
  const replaced=await f.submit(f.input());assert.equal(replaced.status,412);assert.match((await replaced.json()).message,/unresolved operation cannot be retried or replaced/);
  f.sql.prepare('UPDATE repositories SET write_pending=?').run(git.id);
  assert.equal(f.journal().length,1);assert.equal(f.counts().effects,1);
  const pending=await f.pull(), observed=(await value(await f.observe(pending))).observation;
  assert.equal(pending.merged,false);assert.equal(pending.state,'ISSUE_STATE_OPEN');
  assert.equal(observed.nativeCallerCanMerge,false);assert.equal(observed.unavailableReason,'native_write_unresolved');
  // The original request lands at the provider afterwards; only the ref and commit readback settle it.
  f.land();
  const settled=(await value(await f.inspect(body))).operation;
  assert.equal(settled.phase,mergePhase('SUCCEEDED'));assert.equal(settled.mergeCommitId,git.new_sha);assert.equal(settled.actualBaseCommitId,commit);assert.equal(settled.createdAt,unknown.createdAt);
  assert.equal(f.counts().effects,1);assert.equal(f.journal()[0].detail,'provider_unavailable');
  assert.equal(f.sql.prepare('SELECT state FROM git_operations').get().state,'APPLIED');assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
  assert.equal((await f.pull()).mergeCommitId,git.new_sha);
  assert.deepEqual((await value(await f.submit(body))).operation,settled);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM discussion_events WHERE kind='merge_pull'").get().n,1);
});

test('a lost provider reply after an applied native merge is confirmed by the immediate readback', async t => {
  const f=await mergeFixture(t); f.loseReply();
  const operation=(await value(await f.submit(f.input()))).operation;
  assert.equal(operation.phase,mergePhase('SUCCEEDED'));assert.equal(f.counts().effects,1);
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
  // The lost reply stays recorded on the confirmed operation.
  assert.equal(f.journal()[0].detail,'provider_unavailable');
});

test('a provider that ends the session busy (ERR) refused the merge: the repository is released at once, not after maintenance', async t => {
  const f=await mergeFixture(t), body=f.input(); f.busy();
  const refused=(await value(await f.submit(body))).operation;
  assert.equal(refused.phase,mergePhase('REJECTED'));assert.equal(refused.refusalCode,'provider_refused');
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
  const git=f.sql.prepare('SELECT * FROM git_operations').get();
  assert.equal(f.sql.prepare('SELECT outcome FROM git_ref_writes WHERE operation_id=?').get(git.id).outcome,'NOT_APPLIED');
  // The next merge goes through.
  const merged=(await value(await f.submit({...f.input(),operationId:crypto.randomUUID()}))).operation;
  assert.equal(merged.phase,mergePhase('SUCCEEDED'));
});

test('a provider that stores the object but refuses the ref is a refused merge: nothing applied, the repository released', async t => {
  const f=await mergeFixture(t), body=f.input(); f.refuseRef();
  // The provider answered ng for the branch and the branch does not name the merge: a definite refusal, not an unknown outcome.
  const refused=(await value(await f.submit(body))).operation;
  assert.equal(refused.phase,mergePhase('REJECTED'));assert.equal(refused.refusalCode,'provider_refused');
  // The dispatched commit exists at the provider, but the branch does not name it: inspection never adopts it.
  const git=f.sql.prepare('SELECT * FROM git_operations').get(), artifact=f.sql.prepare('SELECT artifact_name FROM repositories WHERE id=1').get().artifact_name;
  assert.equal((await (await f.env.ARTIFACTS.get(artifact)).readCommit(git.new_sha)).hash,git.new_sha);
  assert.equal((await value(await f.inspect(body))).operation.phase,mergePhase('REJECTED'));
  assert.equal(git.state,'DISPATCHED');assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
  assert.equal(f.sql.prepare('SELECT outcome FROM git_ref_writes WHERE operation_id=?').get(git.id).outcome,'NOT_APPLIED');
  assert.equal((await f.pull()).merged,false);assert.equal(f.counts().effects,1);
});

test('a readback that differs from the dispatched merge commit never becomes success', async t => {
  const f=await mergeFixture(t), body=f.input(), get=f.env.ARTIFACTS.get;
  // The ref names the dispatched ID but the provider returns different parents for it.
  f.env.ARTIFACTS.get=async name=>{const repo=await get(name);return {...repo,async readCommit(hash){const value=await repo.readCommit(hash);return value?.parents.length===2?{...value,parents:[value.parents[1],value.parents[0]]}:value;}};};
  assert.equal((await value(await f.submit(body))).operation.phase,mergePhase('DISPATCH_UNKNOWN'));
  assert.equal(f.journal()[0].detail,'readback_unconfirmed');
  assert.equal((await value(await f.inspect(body))).operation.phase,mergePhase('DISPATCH_UNKNOWN'));
  assert.notEqual(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);assert.equal((await f.pull()).merged,false);
  f.env.ARTIFACTS.get=get;
  assert.equal((await value(await f.inspect(body))).operation.phase,mergePhase('SUCCEEDED'));assert.equal(f.counts().effects,1);
});

// Diverged history over the fixture: main gains d and feature gains e, each with its own tree; their merge base is the fixture commit (tree f).
const fixtureEntries=[{name:'hello.txt',hash:'1'.repeat(40),type:'blob',mode:'100644'},{name:'link',hash:'2'.repeat(40),type:'symlink',mode:'120000'},{name:'module',hash:'3'.repeat(40),type:'gitlink',mode:'160000'}];
const fileEntry=(name,hash)=>({name,hash,type:'blob',mode:'100644'});
function diverge(f,baseTree,headTree){
  const [d,e,dt,et]=['d','e','6','7'].map(c=>c.repeat(40)), get=f.env.ARTIFACTS.get;
  const commits={[d]:{tree:dt,parents:[commit]},[e]:{tree:et,parents:['b'.repeat(40)]}}, trees={[dt]:baseTree,[et]:headTree};
  f.env.ARTIFACTS.get=async name=>{const repo=await get(name);return {...repo,
    async readCommit(hash){const c=commits[hash];return c?{hash,treeHash:c.tree,parents:c.parents,message:'Diverged',author:{name:'Bob'},authoredAt:1700000001}:repo.readCommit(hash);},
    async readTree(hash){return trees[hash]||repo.readTree(hash);}};};
  f.setRefs([['refs/heads/main',d],['refs/heads/feature',e]]);
  return {d,e,selection:{...f.selection,baseCommitId:d,headCommitId:e}};
}
const providerRepo=async f=>f.env.ARTIFACTS.get(f.sql.prepare('SELECT artifact_name FROM repositories WHERE id=1').get().artifact_name);
const cleanDivergence=async f=>{
  const v=diverge(f,[...fixtureEntries,fileEntry('base.txt','4'.repeat(40))],[...fixtureEntries,fileEntry('feature.txt','5'.repeat(40))]);
  return {...v,tree:await treeObject([...fixtureEntries,fileEntry('base.txt','4'.repeat(40)),fileEntry('feature.txt','5'.repeat(40))]),pull:await f.pull()};
};

test('native merge three-way merges diverged branches into a verified two-parent commit with the merged tree', async t => {
  const f=await mergeFixture(t), v=await cleanDivergence(f);
  const observed=(await value(await f.observe(v.pull))).observation;
  assert.equal(observed.nativeCallerCanMerge,true);assert.equal(observed.unavailableReason,'protected_integration_unqualified');assert.equal(observed.mergeConflicts,undefined);
  assert.deepEqual(observed.mergeConfiguration,{allowMergeCommits:true,allowSquashMerge:true,defaultMergeStyle:'merge',defaultUpdateStyle:'merge'});
  const body=f.input({selection:v.selection,expectedPullRevision:v.pull.revision}), operation=(await value(await f.submit(body))).operation;
  assert.equal(operation.phase,mergePhase('SUCCEEDED'));assert.equal(operation.actualBaseCommitId,v.d);assert.equal(operation.headCommitId,v.e);
  // Journal evidence stays out of the receipt.
  assert.deepEqual(Object.keys(operation).sort(),['actorId','actualBaseCommitId','contract','createdAt','expectedPullRevision','failureCode','headCommitId','mergeCommitId','method','number','observedBaseCommitId','operationId','ownerId','phase','pullRequestId','repository','repositoryId','sourceRef','targetRef','updatedAt']);
  assert.equal(JSON.parse(f.journal()[0].original).expectedTreeId,v.tree.id);
  // The provider decoded the commit and the new merged tree from the one pack.
  const repo=await providerRepo(f), stored=await repo.readCommit(operation.mergeCommitId);
  assert.deepEqual(stored.parents,[v.d,v.e]);assert.equal(stored.treeHash,v.tree.id);assert.equal(stored.message,`Merge pull request #${f.pr.number} from feature into main\n`);
  assert.deepEqual((await repo.readTree(v.tree.id)).map(entry=>[entry.name,entry.hash,entry.mode]),[['base.txt','4'.repeat(40),'100644'],['feature.txt','5'.repeat(40),'100644'],['hello.txt','1'.repeat(40),'100644'],['link','2'.repeat(40),'120000'],['module','3'.repeat(40),'160000']]);
  assert.deepEqual({...f.sql.prepare('SELECT old_sha,new_sha,state FROM git_operations').get()},{old_sha:v.d,new_sha:operation.mergeCommitId,state:'APPLIED'});
  assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
  assert.deepEqual((await value(await f.submit(body))).operation,operation);assert.deepEqual((await value(await f.inspect(body))).operation,operation);
  assert.equal(f.counts().effects,1);assert.equal(f.journal().length,1);
  const merged=await f.pull();
  assert.equal(merged.merged,true);assert.equal(merged.mergeCommitId,operation.mergeCommitId);assert.equal(merged.base.commitId,v.d);assert.equal(merged.head.commitId,v.e);assert.equal(merged.mergeBaseCommitId,commit);
});

test('native squash writes one commit with the base as its only parent and the head or merged tree', async t => {
  await t.test('head contains the base', async t => {
    const f=await mergeFixture(t), body=f.input({method:'squash'}), operation=(await value(await f.submit(body))).operation;
    assert.equal(operation.phase,mergePhase('SUCCEEDED'));assert.equal(operation.method,'squash');assert.equal(operation.actualBaseCommitId,commit);
    const stored=await (await providerRepo(f)).readCommit(operation.mergeCommitId);
    assert.deepEqual(stored.parents,[commit]);assert.equal(stored.treeHash,'f'.repeat(40));assert.equal(stored.message,`Proposal (#${f.pr.number})\n`);
    assert.equal(JSON.parse(f.journal()[0].original).expectedTreeId,'f'.repeat(40));
    assert.deepEqual((await value(await f.submit(body))).operation,operation);assert.equal(f.counts().effects,1);
    const merged=await f.pull();assert.equal(merged.merged,true);assert.equal(merged.state,'ISSUE_STATE_CLOSED');assert.equal(merged.mergeCommitId,operation.mergeCommitId);
  });
  await t.test('diverged branches', async t => {
    const f=await mergeFixture(t), v=await cleanDivergence(f);
    const body=f.input({method:'squash',commitTitle:'Squash feature',commitMessage:'Both sides kept.',selection:v.selection,expectedPullRevision:v.pull.revision});
    const operation=(await value(await f.submit(body))).operation;
    assert.equal(operation.phase,mergePhase('SUCCEEDED'));assert.equal(operation.actualBaseCommitId,v.d);
    const stored=await (await providerRepo(f)).readCommit(operation.mergeCommitId);
    assert.deepEqual(stored.parents,[v.d]);assert.equal(stored.treeHash,v.tree.id);assert.equal(stored.message,'Squash feature\n\nBoth sides kept.\n');
    assert.doesNotMatch(JSON.stringify(f.journal()),/Squash feature|Both sides/);
    assert.deepEqual((await value(await f.submit(body))).operation,operation);assert.deepEqual((await value(await f.inspect(body))).operation,operation);assert.equal(f.counts().effects,1);
  });
});

test('native merge refuses conflicting diverged branches and lists at most 50 conflicting paths with their count', async t => {
  const f=await mergeFixture(t), files=prefix=>Array.from({length:60},(_,i)=>fileEntry('c'+String(i).padStart(2,'0'),prefix+String(i).padStart(39,'0')));
  const others=fixtureEntries.filter(entry=>entry.name!=='hello.txt'), get=f.env.ARTIFACTS.get;
  // Both sides changed these files: the merge reads them line by line. Each fixture blob is one line, its own hash.
  f.env.ARTIFACTS.get=async name=>{const repo=await get(name),readBlob=repo.readBlob;repo.readBlob=async hash=>await readBlob(hash)??new Blob([hash+'\n']);return repo;};
  const v=diverge(f,[...others,fileEntry('hello.txt','8'.repeat(40)),...files('4')],[...others,fileEntry('hello.txt','9'.repeat(40)),...files('5')]), pull=await f.pull();
  const expected=Array.from({length:50},(_,i)=>({path:'c'+String(i).padStart(2,'0'),reason:'both_added'}));
  const observed=(await value(await f.observe(pull))).observation;
  assert.equal(observed.nativeCallerCanMerge,false);assert.equal(observed.unavailableReason,'native_merge_conflict');assert.equal(Object.values(observed.mergeConfiguration).some(v=>v===true),false);
  assert.deepEqual(observed.mergeConflicts,expected);assert.equal(observed.mergeConflictCount,61);
  for(const method of ['merge','squash']) {
    const body=f.input({method,selection:v.selection,expectedPullRevision:pull.revision}), operation=(await value(await f.submit(body))).operation, row=f.journal().at(-1);
    assert.equal(operation.phase,mergePhase('REJECTED'));assert.equal(operation.failureCode,'preflight_refused');assert.equal(operation.refusalCode,'merge_conflict');
    assert.deepEqual(operation.conflicts,expected);assert.equal(operation.conflictCount,61);assert.equal(operation.mergeCommitId,'');
    assert.equal(row.detail,'merge_conflict');assert.equal(row.git_operation_id,null);assert.equal(JSON.parse(row.original).conflicts.length,50);
    assert.deepEqual((await value(await f.submit(body))).operation,operation);assert.deepEqual((await value(await f.inspect(body))).operation,operation);
  }
  // Only the two differently changed files conflict when the rest merges.
  const small=diverge(f,[...others,fileEntry('hello.txt','8'.repeat(40))],[...others.filter(entry=>entry.name!=='link'),fileEntry('hello.txt','9'.repeat(40))]);
  const conflicted=(await value(await f.observe(await f.pull()))).observation;
  assert.deepEqual(conflicted.mergeConflicts,[{path:'hello.txt',reason:'both_modified'}]);assert.equal(conflicted.mergeConflictCount,1);assert.equal(small.d,v.d);
  assert.equal(f.counts().effects,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM git_operations').get().n,0);assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
  assert.equal((await f.pull()).merged,false);
});

test('an unconfirmed diverged merge or squash settles only when the readback has the expected parents and tree', async t => {
  for(const method of ['merge','squash']) await t.test(method, async t => {
    const f=await mergeFixture(t), v=await cleanDivergence(f), body=f.input({method,selection:v.selection,expectedPullRevision:v.pull.revision}); f.losePush();
    const unknown=(await value(await f.submit(body))).operation, git=f.sql.prepare('SELECT * FROM git_operations').get();
    assert.equal(unknown.phase,mergePhase('DISPATCH_UNKNOWN'));assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,git.id);
    assert.equal(JSON.parse(f.journal()[0].original).expectedTreeId,v.tree.id);
    const blocked=(await value(await f.observe(v.pull))).observation;assert.equal(blocked.unavailableReason,'native_write_unresolved');assert.equal(blocked.nativeCallerCanMerge,false);
    f.land();
    // The ref names the dispatched commit, but a readback with any other tree is never adopted.
    const get=f.env.ARTIFACTS.get;
    f.env.ARTIFACTS.get=async name=>{const repo=await get(name);return {...repo,async readCommit(hash){const value=await repo.readCommit(hash);return hash===git.new_sha?{...value,treeHash:'f'.repeat(40)}:value;}};};
    assert.equal((await value(await f.inspect(body))).operation.phase,mergePhase('DISPATCH_UNKNOWN'));
    f.env.ARTIFACTS.get=get;
    const settled=(await value(await f.inspect(body))).operation, stored=await (await providerRepo(f)).readCommit(git.new_sha);
    assert.equal(settled.phase,mergePhase('SUCCEEDED'));assert.equal(settled.mergeCommitId,git.new_sha);assert.equal(settled.actualBaseCommitId,v.d);
    assert.deepEqual(stored.parents,method==='squash'?[v.d]:[v.d,v.e]);assert.equal(stored.treeHash,v.tree.id);
    assert.equal(f.counts().effects,1);assert.equal(f.sql.prepare('SELECT write_pending FROM repositories').get().write_pending,null);
    assert.deepEqual((await value(await f.submit(body))).operation,settled);assert.equal(f.counts().effects,1);
  });
});

test('CI registry broker requires an admitted exact-source job and never forwards caller credentials', async t => {
  const {testRegistry,registryExecution}=await import('./src/core.mjs');
  const {registryAuthority}=await import('./src/repository-settings.mjs');
  const f=await evidenceFixture(t);allocateTests(f);
  f.env.REGISTRY_CI_ENABLED='true';f.env.REGISTRY_ORIGIN='https://registry.example.com';
  f.env.registryExecution=(actor,row,execution)=>registryExecution(f.env,actor,row,execution);
  let issued=0,exchanged=0,forwarded=0;
  f.env.REGISTRY={
    async manage(input) {issued++;assert.equal(input.action,'jobCredential');assert.equal((await registryAuthority(f.env,input)).execution,true);return {credential:'job-secret',expiresAt:input.execution.expiresAt,registry:f.env.REGISTRY_ORIGIN,name:input.binding.name};},
    async fetch(request) {if(new URL(request.url).pathname==='/token') {exchanged++;assert.equal(request.headers.get('Authorization'),'Basic '+btoa('golf:job-secret'));return Response.json({token:'job-access',expires_in:300});}
      forwarded++;assert.equal(request.headers.get('Authorization'),'Bearer job-access');assert.equal(request.headers.get('Cookie'),null);assert.equal(request.headers.get('X-Secret'),null);return new Response('registry');},
  };
  const job=(await value(await f.evidence({...f.input,advice:false,runTests:true}))).job;
  const request=url=>new Request(url||f.env.REGISTRY_ORIGIN+'/v2/alice/project/manifests/ci-'+job.id,{headers:{Authorization:'Bearer attacker',Cookie:'private','X-Secret':'private'}});
  assert.equal((await testRegistry(f.env,job.id,request())).status,403);
  await f.advance(job.id,'tests');
  for(let i=0;i<2;i++) assert.equal((await testRegistry(f.env,job.id,request())).status,200);
  assert.deepEqual([issued,exchanged,forwarded],[1,1,2]);
  for(const url of ['https://other.example.com/v2/','https://registry.example.com/v2/alice/other/tags/list','https://registry.example.com/api/v1/alice/project/manage','https://registry.example.com/v2/alice/project/manifests/%61']) assert.equal((await testRegistry(f.env,job.id,request(url))).status,403);
  const stored=f.sql.prepare('SELECT * FROM evidence_jobs WHERE id=?').get(job.id),snapshot=JSON.parse(stored.snapshot),row=f.sql.prepare('SELECT * FROM repositories WHERE id=1').get();
  const execution={contract:'golf.registry-job.v1',jobId:job.id,commitId:snapshot.execution.commitId,policySha256:snapshot.execution.policySha256,expiresAt:Date.parse(stored.expires_at)};
  assert.equal(await registryExecution(f.env,'2',row,execution),false);
  assert.equal(await registryExecution(f.env,'1',row,{...execution,commitId:'c'.repeat(40)}),false);
  f.env.registryCredentials.clear();
  f.env.REGISTRY.manage=async()=>({registryError:{status:503,diagnostic:'provider failed Bearer private-value'}});
  const unavailable=await testRegistry(f.env,job.id,request());
  assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('X-Golf-Registry-Broker-Error'),'1');
  assert.equal(await unavailable.text(),'Registry management: provider failed [private]');
  f.setRefs([['refs/heads/main',commit],['refs/heads/feature','c'.repeat(40)]]);
  assert.equal((await testRegistry(f.env,job.id,request())).status,403);
  assert.equal(forwarded,2);
});

test('managed package inventory joins real D1 source receipts and rejects mismatched image provenance', async t => {
  const f = await evidenceFixture(t); allocateTests(f);
  const name='a'.repeat(32)+'/golf-demo-r1', imageDigest='sha256:'+'d'.repeat(64);
  let artifact;
  Object.assign(f.env, { REGISTRY_PROVIDER:'cloudflare', REGISTRY_CI_ENABLED:'true', REGISTRY_ORIGIN:'https://registry.cloudflare.com', REGISTRY_ACCOUNT:'a'.repeat(32), REGISTRY_REPOSITORY_PREFIX:'a'.repeat(32)+'/golf-demo-r',
    REGISTRY:{manage:async input=>({enabled:true,provider:'cloudflare',registry:'https://registry.cloudflare.com',name:input.binding.name,imageRepository:name,artifacts:[{...artifact}]})} });
  const job=(await value(await f.evidence({...f.input,advice:false,runTests:true}))).job;
  const selected=JSON.parse(f.sql.prepare('SELECT snapshot FROM evidence_jobs WHERE id=?').get(job.id).snapshot).selection;
  const tests={state:'PASSED',cleanup:'destroyed',jobId:job.id,commitId:selected.headCommitId,finishedAt:Date.now(),image:{digest:imageDigest,repository:name}};
  f.sql.prepare("UPDATE evidence_jobs SET state='SUCCEEDED',test_state='PASSED',test_result=? WHERE id=?").run(JSON.stringify(tests),job.id);
  artifact={tag:'ci-'+job.id,digest:imageDigest,mediaType:'application/vnd.oci.image.manifest.v1+json',platforms:[],size:123,publishedAt:''};
  const read=()=>handle(new Request(f.env.PUBLIC_ORIGIN+'/native/repository-packages',{method:'POST',headers:{Authorization:'Bearer '+ownerToken,'Content-Type':'application/json','Connect-Protocol-Version':'1'},body:JSON.stringify({repository:selected.repository,repositoryId:selected.repositoryId,action:'status'})}),f.env);
  let response=await read(); assert.equal(response.status,200,await response.clone().text());
  const inventory=await response.json();assert.deepEqual(inventory.artifacts[0].build,{jobId:job.id,commitId:selected.headCommitId,pullNumber:selected.number});
  assert.equal(inventory.artifacts[0].publishedAt,new Date(tests.finishedAt).toISOString());
  artifact.digest='sha256:'+'e'.repeat(64);assert.equal((await (await read()).json()).artifacts[0].build,undefined);
  f.sql.exec('UPDATE users SET active=0 WHERE id=1');response=await read();assert.equal(response.status,401);assert.ok(!(await response.text()).includes(selected.headCommitId));
});

test('managed registry admission uses immutable repository IDs and fences cross-job writes, stale source and revoked users', async t => {
  const { testRegistry, registryExecution } = await import('./src/core.mjs');
  const { registryAuthority } = await import('./src/repository-settings.mjs');
  const { managedRegistry, managedOrigin } = await import('./src/managed-registry.mjs');
  const f = await evidenceFixture(t); allocateTests(f);
  const account = 'a'.repeat(32), name = account + '/golf-demo-r1';
  Object.assign(f.env, { REGISTRY_PROVIDER: 'cloudflare', REGISTRY_CI_ENABLED: 'true', REGISTRY_ORIGIN: managedOrigin, REGISTRY_ACCOUNT: account,
    REGISTRY_REPOSITORY_PREFIX: account + '/golf-demo-r', REGISTRY_API_TOKEN: { get: async () => 'private-api-token' } });
  f.env.REGISTRY = managedRegistry(f.env, input => registryAuthority(f.env, input));
  let forwarded = 0;
  f.env.registryProviderFetch = async (url, options) => {
    if (url.startsWith('https://api.cloudflare.com/')) return Response.json({ success: true, result: { account_id: account, registry_host: 'registry.cloudflare.com', username: 'operator', password: 'private-registry-token' } });
    forwarded++; assert.equal(options.headers.get('Authorization'), 'Basic ' + btoa('operator:private-registry-token'));
    assert.equal(options.headers.get('Cookie'), null); return new Response(null, { status: 404 });
  };
  const job = (await value(await f.evidence({ ...f.input, advice: false, runTests: true }))).job;
  const stored = f.sql.prepare('SELECT * FROM evidence_jobs WHERE id=?').get(job.id), snapshot = JSON.parse(stored.snapshot);
  assert.equal(snapshot.execution.registry.name, name);
  const request = (suffix, method = 'GET', body) => new Request(managedOrigin + '/v2/' + name + '/' + suffix, { method, body, headers: { Authorization: 'Bearer caller', Cookie: 'private' } });
  assert.equal((await testRegistry(f.env, job.id, request('manifests/ci-' + job.id))).status, 403);
  await f.advance(job.id, 'tests');
  assert.equal((await testRegistry(f.env, job.id, request('manifests/ci-' + job.id))).status, 404);
  for (const suffix of ['manifests/latest', 'tags/list', 'blobs/uploads/?mount=sha256:' + 'b'.repeat(64) + '&from=other']) {
    assert.equal((await testRegistry(f.env, job.id, request(suffix, 'POST'))).status, 403);
  }
  assert.equal(forwarded, 1);
  const row = f.sql.prepare('SELECT * FROM repositories WHERE id=1').get();
  const execution = { contract: 'golf.registry-job.v1', jobId: job.id, commitId: snapshot.execution.commitId, policySha256: snapshot.execution.policySha256, expiresAt: Date.parse(stored.expires_at) };
  assert.equal(await registryExecution(f.env, '1', row, execution), true);
  f.sql.exec('UPDATE users SET active=0 WHERE id=1');
  assert.equal((await testRegistry(f.env, job.id, request('manifests/ci-' + job.id))).status, 403);
  assert.equal(forwarded, 1);
});

test('personal ownership and organizations preserve repository identity and fence foreign owners', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush();
  const manage = (body,token=ownerToken) => f.call('',body,token,'/native/owners');
  const adoption = {action:'ensurePersonal',userId:'1',expectedLogin:'alice',login:'mj'};
  assert.equal((await manage({...adoption,userId:'2'})).status,400);
  assert.equal((await manage(adoption,readerToken)).status,404);
  assert.equal((await manage(adoption)).status,200);
  assert.equal((await manage(adoption)).status,200);
  const personal={owner:'mj',name:'project'};
  assert.equal((await f.call('GetRepository',{repository:{owner:'alice',name:'project'}})).status,404);
  const repository=(await (await f.call('GetRepository',{repository:personal})).json()).repository;
  assert.equal(repository.id,'1');assert.equal(repository.fullName,'mj/project');assert.match(repository.cloneUrl,/\/git\/mj\/project\.git$/);
  const access=(await (await f.call('GetRepositoryAccess',{repository:personal},ownerToken,'/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess')).json()).access;
  assert.equal(access.owner.login,'mj');assert.equal(access.organizationOwned,false);
  const input={action:'createOrganization',slug:'mj-platform',fullName:'MJ Platform',description:'Shared services',idempotencyKey:crypto.randomUUID()};
  const organization=await (await manage(input)).json();assert.equal((await manage(input)).status,200);
  assert.equal((await manage({...input,description:'changed'})).status,409);
  const orgs=token=>f.call('ListOrganizations',{},token,'/rpc/golf.v1.OrganizationService/ListOrganizations');
  assert.deepEqual((await (await orgs(ownerToken)).json()).organizations.map(o=>o.name),['mj-platform']);
  assert.deepEqual((await (await orgs(readerToken)).json()).organizations,[]);
  assert.equal((await manage({action:'listMembers',organization:'mj-platform'},readerToken)).status,404);
  const members=await (await manage({action:'listMembers',organization:'mj-platform'})).json();assert.equal(members.members[0].login,'mj');assert.equal(members.members[0].role,'owner');
  const creation={owner:'mj-platform',name:'api',private:true,idempotencyKey:crypto.randomUUID()};
  f.sql.exec('UPDATE users SET can_create=1 WHERE id=2');
  assert.equal((await f.call('CreateRepository',creation,readerToken)).status,404);
  const created=await (await f.call('CreateRepository',creation)).json();assert.equal(created.repository.fullName,'mj-platform/api');
  assert.equal((await f.call('GetRepository',{repository:{owner:'mj',name:'api'}})).status,404);
  const inventory=await (await f.call('ListRepositories',{owner:'mj-platform',metadataOnly:true})).json();assert.deepEqual(inventory.repositories.map(r=>r.fullName),['mj-platform/api']);
  assert.equal((await f.call('CreateRepository',creation)).status,200);
  f.sql.prepare('DELETE FROM native_owner_members WHERE owner_id=?').run(organization.owner.id);
  assert.equal((await f.call('CreateRepository',{...creation,name:'another',idempotencyKey:crypto.randomUUID()})).status,404);
  assert.deepEqual((await (await orgs(ownerToken)).json()).organizations,[]);
});

test('public source visibility gates anonymous reads, Git, mutations and immediate revocation', async t => {
  const f = await fixture(t); await f.create(); await f.sendPush(); f.env.PUBLIC_REPOSITORIES = 'true';
  const repository = { owner: 'alice', name: 'project' }, target = { repository, repositoryId: '1' };
  const anonymous = (method, body = target, service = 'RepositoryService', extra = {}) => f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.' + service + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...extra }, body: JSON.stringify(body),
  }));
  const visibility = body => f.call('', { ...target, ...body }, ownerToken, '/native/repository-visibility');
  const clone = () => f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/info/refs?service=git-upload-pack'));
  assert.equal((await anonymous('GetRepository')).status, 404);
  assert.equal((await clone()).status, 404);
  const before = await (await visibility({ action: 'get' })).json();
  assert.equal(before.isPublic, false);
  assert.equal((await f.call('', { ...target, action: 'set', isPublic: true, expectedRevision: before.revision }, readerToken, '/native/repository-visibility')).status, 404);
  const published = await visibility({ action: 'set', isPublic: true, expectedRevision: before.revision });
  assert.equal(published.status, 200); const current = await published.json();
  assert.equal((await visibility({ action: 'set', isPublic: false, expectedRevision: before.revision })).status, 412);
  const read = await anonymous('GetRepository'); assert.equal(read.status, 200); assert.equal((await read.json()).repository.private, false);
  assert.equal((await anonymous('GetContents', { ...target, ref: commit, path: 'hello.txt' })).status, 200);
  assert.equal((await clone()).status, 200);
  assert.equal((await anonymous('GetRepositoryAccess', target, 'RepositoryAccessService')).status, 200);
  for (const path of ['pr-evidence', 'pr-preview']) {
    const response = await f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/native/' + path + '/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ ...target, action: 'list', number: 1 }),
    }));
    assert.equal(response.status, 401);
  }
  assert.equal((await anonymous('GetRepository', target, 'RepositoryService', { Authorization: 'Bearer invalid' })).status, 401);
  for (const [service, method] of [['RepositoryService', 'CreateRepository'], ['RepositoryService', 'ListIssues'], ['RepositorySettingsService', 'GetRepositorySettings'], ['OperationsService', 'GetOperationsDashboard']])
    assert.equal((await anonymous(method, target, service)).status, 401);
  assert.equal((await f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/git/alice/project.git/info/refs?service=git-receive-pack'))).status, 401);
  assert.equal((await (await anonymous('ListRepositories', { metadataOnly: true })).json()).repositories.length, 1);
  assert.equal((await visibility({ action: 'set', isPublic: false, expectedRevision: current.revision })).status, 200);
  assert.equal((await anonymous('GetContents', { ...target, ref: commit, path: 'hello.txt' })).status, 404);
  assert.equal((await anonymous('GetRepositoryAccess', target, 'RepositoryAccessService')).status, 404);
  assert.equal((await clone()).status, 404);
  assert.deepEqual((await (await anonymous('ListRepositories', { metadataOnly: true })).json()).repositories, []);
  assert.equal((await f.call('GetRepository', target)).status, 200);
});

test('public profiles and discovery disclose only published fields and currently public owned pins', async t => {
  const f = await fixture(t); await f.create(); f.env.PUBLIC_REPOSITORIES = 'true';
  const target = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1' };
  assert.equal((await f.call('', { action:'ensurePersonal', userId:'1', login:'alice', expectedLogin:'alice' }, ownerToken, '/native/owners')).status,200);
  const profile = (body, token = ownerToken) => f.call('', { owner:'alice',...body }, token, '/native/public-profile');
  const anonymous = (path,body) => f.dispatch(new Request(f.env.PUBLIC_ORIGIN+path,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1'},body:JSON.stringify(body)}));
  assert.equal((await anonymous('/native/public-profile',{action:'get',owner:'alice'})).status,404);
  const draft = await (await profile({action:'get'})).json();
  const input = { enabled:true, displayName:'Alice Developer',bio:'Public bio',location:'Example city',website:'https://example.com',readme:'# About Alice\nBuilding software.',pinned:['1'] };
  assert.equal((await profile({action:'save',ownerId:draft.ownerId,expectedRevision:draft.revision,profile:input})).status,404);
  const visibility = await (await f.call('',{...target,action:'get'},ownerToken,'/native/repository-visibility')).json();
  assert.equal((await f.call('',{...target,action:'set',isPublic:true,expectedRevision:visibility.revision},ownerToken,'/native/repository-visibility')).status,200);
  assert.equal((await profile({action:'save',ownerId:draft.ownerId,expectedRevision:draft.revision,profile:input},readerToken)).status,404);
  assert.equal((await profile({action:'save',ownerId:draft.ownerId,expectedRevision:draft.revision,profile:{...input,email:'private@example.com'}})).status,400);
  assert.equal((await profile({action:'save',ownerId:draft.ownerId,expectedRevision:draft.revision,profile:input})).status,200);
  assert.equal((await profile({action:'save',ownerId:draft.ownerId,expectedRevision:draft.revision,profile:input})).status,412);
  const publicValue = await (await anonymous('/native/public-profile',{action:'get',owner:'alice'})).json();
  assert.equal(publicValue.canEdit,false); assert.equal(publicValue.revision,''); assert.equal(publicValue.readme,input.readme);
  assert.equal(publicValue.pinnedRepositories.length,1); assert.equal(publicValue.publicRepositoryCount,1);
  assert.equal(Object.hasOwn(publicValue,'email'),false); assert.equal(Object.hasOwn(publicValue,'members'),false);
  assert.equal((await anonymous('/native/public-profile',{action:'save',owner:'alice',ownerId:draft.ownerId,profile:input})).status,404);
  f.sql.prepare("INSERT INTO repository_settings(repository_id,description,website,topics,version) VALUES(1,'Python framework','','[\"python\",\"api\"]',1)").run();
  for (const query of [{query:'framework'},{query:'python'},{topic:'api'},{owner:'alice'}]) {
    const result = await anonymous('/native/discover',query); assert.equal(result.status,200); assert.equal((await result.json()).repositories.length,1);
  }
  assert.equal((await (await anonymous('/native/discover',{topic:'rust'})).json()).repositories.length,0);
  const current = await (await f.call('',{...target,action:'get'},ownerToken,'/native/repository-visibility')).json();
  await f.call('',{...target,action:'set',isPublic:false,expectedRevision:current.revision},ownerToken,'/native/repository-visibility');
  const after = await (await anonymous('/native/public-profile',{action:'get',owner:'alice'})).json();
  assert.deepEqual(after.pinnedRepositories,[]); assert.equal(after.publicRepositoryCount,0);
  assert.deepEqual((await (await anonymous('/native/discover',{query:'Python'})).json()).repositories,[]);
});

test('organization public profile changes require current ownership, not membership or instance identity', async t => {
  const f = await fixture(t); f.env.PUBLIC_REPOSITORIES='true';
  const created=await (await f.call('',{action:'createOrganization',slug:'platform',fullName:'Platform',description:'Private draft',idempotencyKey:crypto.randomUUID()},ownerToken,'/native/owners')).json();
  const id=created.owner.id;
  f.sql.prepare("INSERT INTO native_owner_members(owner_id,user_id,role) VALUES(?,2,'member')").run(id);
  const call=(body,token=ownerToken)=>f.call('',{owner:'platform',...body},token,'/native/public-profile');
  const draft=await (await call({action:'get'})).json();
  const profile={enabled:true,displayName:'Platform',bio:'Published description',location:'',website:'',readme:'## Platform engineering',pinned:[]};
  const input={action:'save',ownerId:String(id),expectedRevision:draft.revision,profile};
  assert.equal((await call(input,readerToken)).status,404);
  assert.equal((await call(input)).status,200);
  const published=await (await call({action:'get'},readerToken)).json();
  assert.equal(published.canEdit,false);assert.equal(published.bio,profile.bio);assert.equal(published.publicRepositoryCount,0);
  f.sql.prepare("UPDATE native_owner_members SET role='member' WHERE owner_id=? AND user_id=1").run(id);
  assert.equal((await call({...input,expectedRevision:(await (await call({action:'get'})).json()).revision})).status,404);
});

test('public Git preserves v2 fetch negotiation and remaps ls-refs HEAD to the configured branch', async t => {
  const f=await fixture(t);await f.create();await f.sendPush();f.env.PUBLIC_REPOSITORIES='true';
  f.sql.exec("INSERT INTO repository_visibility(repository_id,is_public) VALUES(1,1)");
  const packets=lines=>Buffer.concat([...lines.map(packetLine),Buffer.from('0000')]);
  const v2=Buffer.concat([packetLine('# service=git-upload-pack\n'),Buffer.from('0000'),packets(['version 2\n','ls-refs\n','fetch=shallow\n'])]);
  const fetchBytes=Buffer.concat([packetLine('shallow-info\n'),packetLine('shallow '+commit+'\n'),Buffer.from('0001'),packetLine('packfile\n'),Buffer.from('0000')]);
  let forwards=0;
  const provider=(url,options)=>{
    if(!options.headers['Git-Protocol'])return f.providerFetch(url,options);
    assert.equal(options.headers['Git-Protocol'],'version=2');forwards++;
    const isGet=options.method==='GET';
    const bytes=isGet?v2:new TextDecoder().decode(options.body).includes('command=ls-refs')?packets([commit+' HEAD symref-target:refs/heads/provider\n',commit+' refs/heads/main\n']):fetchBytes;
    return new Response(bytes,{headers:{'Content-Type':'application/x-git-upload-pack-'+(isGet?'advertisement':'result')}});
  };
  const send=(body)=>handle(new Request(f.env.PUBLIC_ORIGIN+'/git/alice/project.git/'+(body?'git-upload-pack':'info/refs?service=git-upload-pack'),{method:body?'POST':'GET',headers:{'Git-Protocol':'version=2',...(body?{'Content-Type':'application/x-git-upload-pack-request'}:{})},...(body?{body}:{})}),f.env,provider);
  assert.deepEqual(Buffer.from(await (await send()).arrayBuffer()),v2);
  const listed=await send(packets(['command=ls-refs\n']));assert.equal(listed.status,200);assert.match(await listed.text(),/symref-target:refs\/heads\/main/);
  assert.deepEqual(Buffer.from(await (await send(packets(['command=fetch\n']))).arrayBuffer()),fetchBytes);
  assert.equal(forwards,3);assert.equal(f.tokens.size,0);
  // Git gzips a request above about 1 KiB (a fetch with many wants): it is decompressed and forwarded as plain bytes, still bounded.
  const gz=async bytes=>new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const encoded=(body,encoding)=>handle(new Request(f.env.PUBLIC_ORIGIN+'/git/alice/project.git/git-upload-pack',{method:'POST',headers:{'Git-Protocol':'version=2','Content-Type':'application/x-git-upload-pack-request','Content-Encoding':encoding},body}),f.env,provider);
  assert.deepEqual(Buffer.from(await (await encoded(await gz(packets(['command=fetch\n'])),'gzip')).arrayBuffer()),fetchBytes);
  assert.equal(forwards,4);
  assert.equal((await encoded(new Uint8Array([1,2,3,4]),'gzip')).status,400);
  assert.equal((await encoded(packets(['command=fetch\n']),'br')).status,400);
  assert.equal((await encoded(await gz(new Uint8Array(9*1024*1024)),'gzip')).status,413);
  assert.equal(forwards,4);assert.equal(f.tokens.size,0);
});

async function environmentFixture(t) {
  const f = await deliveryFixture(t);
  Object.assign(f.env, { ACCESS_AUD: 'access-aud', EVIDENCE_DAILY_LIMIT: '40' });
  const human = (method, body, email = 'alice@example.com', headers = {}) => f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.RepositoryEnvironmentService/' + method, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...(email ? { 'X-Golf-Native-Access-Email': email } : {}), ...headers }, body: JSON.stringify(body) }));
  const target = async (token = ownerToken) => ({ repository: key, repositoryId: '1', ownerId: '1',
    accessRevision: (await value(await f.call('', { repository: key }, token, '/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess'))).access.revision });
  const policy = (fields = {}) => ({ allowAllSources: true, preventSelfApproval: true, protectedPreviews: true, maxConcurrency: 2, previewTtlSeconds: 600, ...fields });
  const intent = async (fields = {}, extra = {}) => ({ target: await target(), environmentId: nonce(), expectedVersion: '0', operationId: nonce(), name: 'preview', policy: policy(fields), ...extra });
  const save = async (fields, extra) => value(await human('SaveRepositoryEnvironment', await intent(fields, extra)));
  const edit = async (saved, fields) => save(fields, { environmentId: saved.environment.id, expectedVersion: saved.environment.version });
  const rows = () => ['repository_environments', 'repository_environment_versions', 'repository_environment_operations'].map(table => f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  const branch = name => ({ kind: 'REPOSITORY_SOURCE_REF_KIND_BRANCH', name });
  return { ...f, human, target, policy, intent, save, edit, rows, branch };
}
const environmentReady = 'One environment named preview governs protected pull-request previews: allowed head branches, preview lifetime within the operator limit and concurrent previews. Required reviewers, wait timers, environment secrets and production deployment are not available. Changes need a verified Access sign-in.';

test('native environments are ready only with previews and Access; bearer, service-token and non-admin callers are denied', async t => {
  const capability = async f => (await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.filter(c => c.id === 'settings.repository-environments');
  const bare = await capability(await fixture(t));
  assert.equal(bare.length, 1); assert.equal(bare[0].state, 'CAPABILITY_STATE_DISABLED');
  assert.equal(bare[0].reason, 'Repository environments need an operator-approved protected preview allocation and Cloudflare Access sign-in on this installation.');
  const f = await environmentFixture(t); delete f.env.ACCESS_AUD;
  const partial = await capability(f);
  assert.equal(partial[0].state, 'CAPABILITY_STATE_DISABLED'); assert.equal(partial[0].reason, 'Repository environments need Cloudflare Access sign-in on this installation.');
  const refused = await f.human('ListRepositoryEnvironments', { target: await f.target() }); assert.equal(refused.status, 412);
  f.env.ACCESS_AUD = 'access-aud';
  assert.deepEqual(await capability(f), [{ id: 'settings.repository-environments', label: 'Environments', state: 'CAPABILITY_STATE_READY', reason: environmentReady }]);
  const listed = await value(await f.human('ListRepositoryEnvironments', { target: await f.target(), page: { page: 1, limit: 20 } }));
  assert.deepEqual(listed, { target: await f.target(), environments: [], page: { nextPage: 0 }, totalCount: '0', capability: 'REPOSITORY_ENVIRONMENT_CAPABILITY_PREVIEW_POLICY', deploymentAvailable: false });
  assert.equal((await f.human('ListRepositoryEnvironments', { target: await f.target(), page: { limit: 21 } })).status, 400);
  assert.equal((await f.human('ListRepositoryEnvironments', { target: { ...await f.target(), accessRevision: '0'.repeat(64) } })).status, 412);
  assert.equal((await f.human('PromoteRepositoryEnvironment', { target: await f.target() })).status, 501);
  const body = await f.intent();
  // API bearer tokens, Access service tokens and a missing Access identity never administer environments.
  for (const method of ['ListRepositoryEnvironments', 'SaveRepositoryEnvironment', 'DeleteRepositoryEnvironment', 'GetRepositoryEnvironmentOperation'])
    assert.equal((await f.call('', body, ownerToken, '/rpc/golf.v1.RepositoryEnvironmentService/' + method)).status, 404, method);
  assert.equal((await f.human('SaveRepositoryEnvironment', body, 'alice@example.com', { 'CF-Access-Client-Id': 'service.access' })).status, 404);
  assert.equal((await f.human('SaveRepositoryEnvironment', body, 'alice@example.com', { 'CF-Access-Client-Secret': 'secret' })).status, 404);
  assert.equal((await f.human('SaveRepositoryEnvironment', body, '')).status, 401);
  // Readers and writers are not administrators, even with a verified sign-in and their own current revision.
  for (const role of ['read', 'write']) {
    await value(await f.call('', { ...f.grant, role }, ownerToken, '/native/repository-grant'));
    const own = { ...await f.intent(), target: await f.target(readerToken) };
    assert.equal((await f.human('SaveRepositoryEnvironment', own, 'bob@example.com')).status, 404, role);
    assert.equal((await f.human('ListRepositoryEnvironments', { target: own.target }, 'bob@example.com')).status, 404, role);
  }
  assert.deepEqual(f.rows(), [0, 0, 0]);
});

test('native environment saves are version-fenced and replay the original receipt without repeating the change', async t => {
  const f = await environmentFixture(t), body = await f.intent({ allowAllSources: false, sources: [f.branch('release/next'), f.branch('feature')], maxConcurrency: 2, previewTtlSeconds: 300 });
  const saved = await value(await f.human('SaveRepositoryEnvironment', body));
  assert.deepEqual(saved.operation, { operationId: body.operationId, environmentId: body.environmentId, target: body.target, actorId: '1', action: 'REPOSITORY_ENVIRONMENT_ACTION_SAVE', expectedVersion: '0', version: '1', state: 'SUCCEEDED', createdAt: saved.environment.updatedAt });
  assert.deepEqual(saved.environment, { id: body.environmentId, target: body.target, name: 'preview', version: '1', creatorId: '1', updaterId: '1', createdAt: saved.environment.updatedAt, updatedAt: saved.environment.updatedAt, deleted: false,
    capability: 'REPOSITORY_ENVIRONMENT_CAPABILITY_PREVIEW_POLICY', deploymentAvailable: false,
    policy: { allowAllSources: false, sources: [f.branch('release/next'), f.branch('feature')], reviewers: [], requiredApprovals: 0, preventSelfApproval: true, allowAdminBypass: false, waitSeconds: 0, maxConcurrency: 2, protectedPreviews: true, previewTtlSeconds: 300 } });
  assert.match(saved.environment.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual((await value(await f.human('ListRepositoryEnvironments', { target: await f.target() }))).environments, [saved.environment]);
  // Replay returns the stored receipt; the same key with another intent is refused; neither writes.
  assert.deepEqual(await value(await f.human('SaveRepositoryEnvironment', body)), saved);
  assert.equal((await f.human('SaveRepositoryEnvironment', { ...body, policy: f.policy({ maxConcurrency: 1 }) })).status, 412);
  assert.deepEqual(await value(await f.human('GetRepositoryEnvironmentOperation', { target: await f.target(), operationId: body.operationId })), saved);
  assert.equal((await f.human('GetRepositoryEnvironmentOperation', { target: await f.target(), operationId: nonce() })).status, 404);
  assert.deepEqual(f.rows(), [1, 1, 1]);
  // A stale version, a second live environment and a reused identity are refused before any write.
  for (const stale of [{ environmentId: body.environmentId, expectedVersion: '2' }, { environmentId: body.environmentId, expectedVersion: '0' }, {}]) {
    const response = await f.human('SaveRepositoryEnvironment', await f.intent({}, stale));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'aborted');
  }
  assert.equal((await f.human('SaveRepositoryEnvironment', await f.intent({}, { expectedVersion: '1' }))).status, 404);
  assert.deepEqual(f.rows(), [1, 1, 1]);
  const edited = await f.edit(saved, { maxConcurrency: 1 });
  assert.equal(edited.environment.version, '2'); assert.equal(edited.environment.createdAt, saved.environment.createdAt); assert.equal(edited.environment.policy.allowAllSources, true);
  assert.ok(edited.environment.updatedAt >= saved.environment.updatedAt);
  // The first receipt stays the first accepted version, not the current configuration.
  assert.deepEqual(await value(await f.human('SaveRepositoryEnvironment', body)), saved);
  // A changed access revision refuses new changes, while the original operation remains inspectable under its original target.
  const before = await f.intent({}, { environmentId: saved.environment.id, expectedVersion: '2' });
  await value(await f.call('', { ...f.grant, role: 'write' }, ownerToken, '/native/repository-grant'));
  assert.notEqual((await f.target()).accessRevision, before.target.accessRevision);
  const refused = await f.human('SaveRepositoryEnvironment', before); assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'aborted');
  assert.deepEqual(await value(await f.human('SaveRepositoryEnvironment', body)), saved);
  assert.deepEqual(f.rows(), [1, 2, 2]);
  // Another administrator cannot read this actor's receipt.
  f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=2");
  assert.equal((await f.human('GetRepositoryEnvironmentOperation', { target: await f.target(readerToken), operationId: body.operationId }, 'bob@example.com')).status, 404);
  assert.equal((await value(await f.human('ListRepositoryEnvironments', { target: await f.target(readerToken) }, 'bob@example.com'))).environments[0].version, '2');
  // Authority lost between the checks and the D1 transaction commits nothing.
  const racing = await f.intent({}, { environmentId: saved.environment.id, expectedVersion: '2' }), db = f.env.DB.withSession('first-primary');
  f.env.DB.withSession = () => ({ ...db, batch: async statements => { f.sql.exec("UPDATE grants SET role='write' WHERE repository_id=1 AND user_id=1"); return db.batch(statements); } });
  assert.equal((await f.human('SaveRepositoryEnvironment', racing)).status, 404);
  f.env.DB.withSession = () => db; f.sql.exec("UPDATE grants SET role='admin' WHERE repository_id=1 AND user_id=1");
  assert.deepEqual(f.rows(), [1, 2, 2]);
  assert.equal((await f.human('GetRepositoryEnvironmentOperation', { target: await f.target(), operationId: racing.operationId })).status, 404);
  // Deletion keeps history, frees the name and never revives the tombstone.
  const removal = { target: await f.target(), environmentId: saved.environment.id, expectedVersion: '2', operationId: nonce() };
  assert.equal((await f.human('DeleteRepositoryEnvironment', { ...removal, expectedVersion: '0' })).status, 400);
  assert.equal((await f.human('DeleteRepositoryEnvironment', { ...removal, expectedVersion: '1' })).status, 409);
  const removed = await value(await f.human('DeleteRepositoryEnvironment', removal));
  assert.equal(removed.operation.action, 'REPOSITORY_ENVIRONMENT_ACTION_DELETE'); assert.equal(removed.environment.deleted, true); assert.equal(removed.environment.version, '3');
  assert.deepEqual(removed.environment.policy, edited.environment.policy);
  assert.deepEqual(await value(await f.human('DeleteRepositoryEnvironment', removal)), removed);
  assert.deepEqual((await value(await f.human('ListRepositoryEnvironments', { target: await f.target() }))).environments, []);
  assert.equal((await f.human('SaveRepositoryEnvironment', await f.intent({}, { environmentId: saved.environment.id, expectedVersion: '3' }))).status, 409);
  assert.equal((await f.human('SaveRepositoryEnvironment', await f.intent({}, { environmentId: saved.environment.id }))).status, 409);
  assert.equal((await f.save()).environment.version, '1');
  assert.deepEqual(f.rows(), [2, 4, 4]);
});

test('native environments refuse every setting without a consumer', async t => {
  const f = await environmentFixture(t);
  const refusals = [
    [{}, { name: 'production' }, /one environment named preview/], [{}, { name: 'Preview' }, /one environment named preview/],
    [{ reviewers: [{ id: '2', login: 'bob' }], requiredApprovals: 1 }, {}, /reviewers/], [{ requiredApprovals: 1 }, {}, /reviewers/], [{ waitSeconds: 60 }, {}, /wait timers/], [{ allowAdminBypass: true }, {}, /administrator bypass/],
    [{ allowAllSources: false, sources: [{ kind: 'REPOSITORY_SOURCE_REF_KIND_TAG', name: 'v1' }] }, {}, /tag, commit/], [{ allowAllSources: false, sources: [{ kind: 3, name: 'v1' }] }, {}, /tag, commit/],
    [{ allowAllSources: false, sources: [{ kind: 'REPOSITORY_SOURCE_REF_KIND_COMMIT', name: commit }] }, {}, /tag, commit/], [{ allowAllSources: false, sources: [{ kind: 'REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH', name: '' }] }, {}, /tag, commit/],
    [{ allowAllSources: false, sources: [f.branch('release/*')] }, {}, /without wildcards/], [{ allowAllSources: false, sources: [f.branch('main'), f.branch('main')] }, {}, /unique/],
    [{ allowAllSources: false }, {}, /exact branch names/], [{ sources: [f.branch('main')] }, {}, /exact branch names/],
    [{ protectedPreviews: false }, {}, /protected previews only/], [{ preventSelfApproval: false }, {}, /protected previews only/],
    [{ maxConcurrency: 5 }, {}, /between 1 and 4/], [{ maxConcurrency: 0 }, {}, /between 1 and 4/],
    [{ previewTtlSeconds: 901 }, {}, /between 60 and 900 seconds on this installation/], [{ previewTtlSeconds: 59 }, {}, /between 60 and 14400/], [{ previewTtlSeconds: 14401 }, {}, /between 60 and 14400/],
    [{ environmentSecrets: true }, {}, /Provide the preview environment policy/], [{}, { currentPassword: 'not checked here' }, /no account passwords/], [{}, { deploymentAvailable: true }, /canonical/],
    [{}, { environmentId: 'not-a-uuid' }, /canonical/], [{}, { expectedVersion: '01' }, /canonical/],
  ];
  for (const [fields, extra, message] of refusals) {
    const response = await f.human('SaveRepositoryEnvironment', await f.intent(fields, extra)), body = await response.json();
    assert.equal(response.status, 400, JSON.stringify([fields, extra])); assert.equal(body.code, 'invalid_argument'); assert.match(body.message, message);
  }
  assert.deepEqual(f.rows(), [0, 0, 0]);
  // The ceiling is the operator's current value: the same lifetime is accepted at the limit.
  assert.equal((await f.save({ previewTtlSeconds: 900 })).environment.policy.previewTtlSeconds, 900);
});

test('the stored preview environment governs publication: head branch, lifetime under the operator ceiling and concurrent previews', async t => {
  const f = await environmentFixture(t), previews = () => f.sql.prepare('SELECT count(*) AS n FROM previews').get().n;
  const publish = () => f.preview({ ...f.publication, idempotencyKey: nonce() });
  const remaining = preview => (Date.parse(preview.expiresAt) - Date.now()) / 1000;
  const latest = async () => ({ environment: (await value(await f.human('ListRepositoryEnvironments', { target: await f.target() }))).environments[0] });
  // The proposal's head branch is feature; an environment limited to other branches refuses it before any allocation.
  let saved = await f.save({ allowAllSources: false, sources: [f.branch('main'), f.branch('release/next')] });
  let response = await f.preview(f.publication), body = await response.json();
  assert.equal(response.status, 412); assert.match(body.message, /does not allow this pull request head branch/); assert.equal(previews(), 0);
  assert.equal([...f.objects.keys()].filter(k => k.startsWith('native-previews/')).length, 0);
  // Allowing the branch applies the stored 120 second lifetime instead of the operator's 900 second ceiling.
  saved = await f.edit(saved, { allowAllSources: false, sources: [f.branch('feature')], maxConcurrency: 1, previewTtlSeconds: 120 });
  const first = (await value(await f.preview(f.publication))).preview;
  assert.equal(first.state, 'READY'); assert.ok(remaining(first) <= 120 && remaining(first) > 110, String(remaining(first)));
  // One slot: another publication is refused, while the original key still returns the original preview.
  response = await publish(); body = await response.json();
  assert.equal(response.status, 429); assert.match(body.message, /allows 1 concurrent preview for this repository/); assert.equal(previews(), 1);
  assert.equal((await value(await f.preview(f.publication))).preview.id, first.id);
  // The insert itself is fenced: a preview that takes the last slot after the first check leaves nothing behind.
  saved = await f.edit(saved, { maxConcurrency: 2, previewTtlSeconds: 120 });
  const get = f.env.EVIDENCE_BUCKET.get; let raced = false;
  const during = effect => { f.env.EVIDENCE_BUCKET.get = async key => { if (!raced) { raced = true; effect(); } return get(key); }; };
  during(() => f.sql.exec(`INSERT INTO previews(id,repository_id,user_id,job_id,operation_key,input_hash,selection,pr_revision,commit_id,tree_id,source_path,bundle_key,bundle_hash,bundle_bytes,state,created_at,expires_at)
    SELECT '${nonce()}',repository_id,user_id,job_id,'${nonce()}',input_hash,selection,pr_revision,commit_id,tree_id,source_path,bundle_key,bundle_hash,bundle_bytes,'PUBLISHING',created_at,expires_at FROM previews`));
  response = await publish(); body = await response.json();
  assert.equal(raced, true); assert.equal(response.status, 412); assert.match(body.message, /environment changed or its concurrent preview limit was reached/); assert.equal(previews(), 2);
  // So is the policy revision: an edit that lands during publication refuses the publication it was not checked against.
  f.sql.exec("DELETE FROM previews WHERE state='PUBLISHING'"); raced = false;
  during(() => f.sql.exec(`INSERT INTO repository_environment_versions SELECT environment_id,version+1,repository_id,name,deleted,policy,target,creator_id,actor_id,environment_created_at,created_at FROM repository_environment_versions WHERE version=${saved.environment.version};
    UPDATE repository_environments SET version=version+1`));
  response = await publish(); assert.equal(raced, true); assert.equal(response.status, 412); assert.equal(previews(), 1);
  f.env.EVIDENCE_BUCKET.get = get;
  const second = (await value(await publish())).preview; assert.equal(second.state, 'READY'); assert.equal(previews(), 2);
  assert.equal((await publish()).status, 429);
  // Revoking releases a slot.
  await value(await f.preview({ action: 'revoke', previewId: second.id }));
  assert.equal((await value(await publish())).preview.state, 'READY');
  // Renewal follows the current environment as well: a branch no longer allowed is not extended.
  await f.edit(await latest(), { allowAllSources: false, sources: [f.branch('main')] });
  response = await f.preview({ action: 'renew', previewId: first.id, expectedExpiresAt: first.expiresAt }); body = await response.json();
  assert.equal(response.status, 412); assert.match(body.message, /does not allow this pull request head branch/);
  assert.equal(f.sql.prepare('SELECT expires_at FROM previews WHERE id=?').get(first.id).expires_at, first.expiresAt);
  // More live previews than a lowered limit are not extended either.
  await f.edit(await latest(), { maxConcurrency: 1 });
  response = await f.preview({ action: 'renew', previewId: first.id, expectedExpiresAt: first.expiresAt }); assert.equal(response.status, 429);
  const relaxed = await f.edit(await latest(), { previewTtlSeconds: 300 });
  const renewed = (await value(await f.preview({ action: 'renew', previewId: first.id, expectedExpiresAt: first.expiresAt }))).preview;
  assert.ok(remaining(renewed) <= 300 && remaining(renewed) > 290, String(remaining(renewed)));
  // An operator ceiling lowered below a stored lifetime still wins.
  f.env.PREVIEW_TTL = '60';
  const capped = (await value(await f.preview({ action: 'renew', previewId: first.id, expectedExpiresAt: renewed.expiresAt }))).preview;
  assert.ok(remaining(capped) <= 60 && remaining(capped) > 50, String(remaining(capped)));
  f.env.PREVIEW_TTL = '900';
  // Without an environment only the operator allocation applies.
  await value(await f.human('DeleteRepositoryEnvironment', { target: await f.target(), environmentId: relaxed.environment.id, expectedVersion: relaxed.environment.version, operationId: nonce() }));
  const ungoverned = (await value(await publish())).preview; assert.ok(remaining(ungoverned) <= 900 && remaining(ungoverned) > 890, String(remaining(ungoverned)));
});

// Workflow files layered over the fixture tree: '.github/workflows/<name>' and root entries, each a source string or { type, source }.
const shellWorkflow = 'name: Verify\non: pull_request\njobs:\n  check:\n    runs-on: golf-native-linux\n    steps:\n      - run: python3 -m unittest -v test_calc\n';
function workflowFiles(f, files) {
  const get = f.env.ARTIFACTS.get, github = '4'.repeat(40), folder = '5'.repeat(40), blobs = new Map(), root = [], nested = [];
  let reads = 0;
  Object.entries(files).forEach(([path, value], index) => {
    const hash = (index + 1).toString(16).padStart(4, '0').repeat(10), name = path.replace('.github/workflows/', '');
    blobs.set(hash, typeof value === 'string' ? value : value.source);
    (name === path ? root : nested).push({ name, hash, type: value.type || 'blob', mode: '100644' });
  });
  f.env.ARTIFACTS.get = async name => {
    const repo = await get(name), readTree = repo.readTree, readBlob = repo.readBlob;
    return { ...repo,
      async readTree(hash) { return hash === 'f'.repeat(40) ? [...await readTree(hash), ...root, ...(nested.length ? [{ name: '.github', hash: github, type: 'tree', mode: '040000' }] : [])] :
        hash === github ? [{ name: 'workflows', hash: folder, type: 'tree', mode: '040000' }] : hash === folder ? nested : readTree(hash); },
      async readBlob(hash) { if (!blobs.has(hash)) return readBlob(hash); reads++; return new Blob([blobs.get(hash)]); },
    };
  };
  return { reads: () => reads };
}

test('an approved Actions workflow beside the approved module leaves agent admission unchanged', async t => {
  for (const combined of [false, true]) await t.test(combined ? 'module and workflow' : 'module only', async t => {
    const f = await evidenceFixture(t), input = { ...f.input, advice: false, agent: { prompt: 'Improve the approved source file.' } };
    assert.equal((await f.evidence(input)).status, 412);
    const execution = allocateAgents(f);
    if (combined) { Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/ci.yml' }); workflowFiles(f, { '.github/workflows/ci.yml': shellWorkflow }); }
    const config = await value(await f.call('', {}, ownerToken, '/native/config'));
    assert.equal(config.agents, true); assert.equal(config.testModule, 'test_calc'); assert.equal(config.testWorkflowPath, combined ? '.github/workflows/ci.yml' : '');
    assert.equal((await f.evidence(input, readerToken)).status, 404);
    for (const agent of [null, {}, { prompt: '' }, { prompt: 'a'.repeat(16385) }, { prompt: 'Fix', remote: 'external' }]) assert.equal((await f.evidence({ ...input, agent })).status, 400);
    assert.equal((await f.evidence({ ...input, runTests: true })).status, 400);
    const job = (await value(await f.evidence(input))).job;
    assert.equal(job.agentState, 'REQUESTED'); assert.equal((await value(await f.evidence(input))).job.id, job.id);
    assert.equal((await f.evidence({ ...input, agent: { prompt: 'Different' } })).status, 409);
    const snapshot = JSON.parse(f.sql.prepare('SELECT snapshot FROM evidence_jobs WHERE id=?').get(job.id).snapshot);
    assert.equal(snapshot.agent.module, 'test_calc'); assert.equal(snapshot.execution, undefined);
    await f.advance(job.id, 'agents'); await f.advance(job.id, 'agents');
    assert.equal(execution.admissions(), 1); assert.equal(f.forks(), 1);
    const task = execution.tasks.get(job.id);
    assert.equal(task.commitId, f.selection.headCommitId); assert.equal(task.module, 'test_calc'); assert.equal(task.workflow, undefined);
    assert.equal((await f.advance(job.id, 'authorize-agent')).state, 'AUTHORIZED');
    // Pull-request runs take the workflow when one is approved; the agent job keeps its module.
    const run = (await value(await f.evidence({ ...f.input, advice: false, runTests: true, idempotencyKey: nonce() }))).job;
    const execute = JSON.parse(f.sql.prepare('SELECT snapshot FROM evidence_jobs WHERE id=?').get(run.id).snapshot).execution;
    assert.equal(execute.contract, combined ? 'golf.native.workflow-shell.v1' : 'golf.native.pr-test.v1');
    assert.equal(execute.module, combined ? undefined : 'test_calc'); assert.equal(execute.workflow?.path, combined ? '.github/workflows/ci.yml' : undefined);
    assert.equal((await f.advance(run.id, 'authorize-test')).state, 'AUTHORIZED');
    f.env.TEST_MODULE = 'other_module';
    assert.equal((await f.advance(job.id, 'agents')).state, 'REFUSED');
  });
});

async function inventoryFixture(t) { const f = await fixture(t); await f.create(); await f.sendPush(); return f; }
const inspect = (f, body = {}, token = ownerToken) => f.call('', { repository: key, ...body }, token, '/rpc/golf.v1.WorkflowService/InspectWorkflows');
const workflowReason = async f => (await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.find(c => c.id === 'settings.repository-workflows');
function allocateEvidence(f) {
  Object.assign(f.env, { EVIDENCE_DAILY_LIMIT: '2', EVIDENCE_WORKFLOW_NAME: 'test-evidence', EVIDENCE_QUEUE_NAME: 'test-evidence', EVIDENCE_QUEUE: { async send() {} }, EVIDENCE_BUCKET: {} });
}

test('native workflow inventory reads the default branch for current repository accounts only', async t => {
  const empty = await fixture(t); await empty.create();
  assert.equal((await inspect(empty)).status, 412);
  const f = await inventoryFixture(t), origin = f.env.PUBLIC_ORIGIN, path = '/rpc/golf.v1.WorkflowService/InspectWorkflows';
  const listed = await value(await inspect(f, { repositoryId: '1' }));
  assert.deepEqual({ ...listed, policyRevision: '' }, { repositoryId: '1', commitId: commit, catalogVersion: 'golf.native.workflow-inventory.v1', executionAvailable: false, configurations: [],
    diagnostics: [{ code: 'module_profile', message: 'None of these files can run: this installation executes one operator-approved Python test module on pull requests.' }], policyRevision: '', executionCatalog: '', executionEngineCommit: '' });
  assert.match(listed.policyRevision, /^[a-f0-9]{64}$/);
  assert.equal((await inspect(f, { ref: 'main' })).status, 400);
  assert.equal((await inspect(f, { repositoryId: '2' })).status, 404);
  assert.equal((await inspect(f, { repository: { owner: 'alice', name: 'other' } })).status, 404);
  assert.equal((await inspect(f, {}, readerToken)).status, 404);
  await value(await f.call('', { repository: key, repositoryId: '1', userId: '2', role: 'read' }, ownerToken, '/native/repository-grant'));
  assert.equal((await value(await inspect(f, {}, readerToken))).commitId, commit);
  // Publishing source does not publish the settings inventory: no grant, no answer.
  const anonymous = () => f.dispatch(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ repository: key }) }));
  assert.equal((await anonymous()).status, 401);
  f.env.PUBLIC_REPOSITORIES = 'true'; f.sql.exec('INSERT INTO repository_visibility(repository_id,is_public) VALUES(1,1)');
  assert.equal((await f.call('GetRepository', { repository: key }, readerToken)).status, 200);
  assert.equal((await anonymous()).status, 401);
  f.sql.prepare('DELETE FROM grants WHERE repository_id=1 AND user_id=2').run();
  assert.equal((await f.call('GetRepository', { repository: key }, readerToken)).status, 200);
  assert.equal((await inspect(f, {}, readerToken)).status, 404);
  assert.equal(concurrentRead(new Request(origin + path, { method: 'POST' })), true);
  const capability = await workflowReason(f);
  assert.equal(capability.state, 'CAPABILITY_STATE_READY');
  assert.equal(capability.reason, 'Lists workflow files at the default-branch commit. None can run: pull-request test execution is not allocated on this installation.');
});

test('the module profile marks no workflow runnable and a workflow profile marks only its approved path', async t => {
  const f = await inventoryFixture(t); allocateEvidence(f); allocateTests(f);
  workflowFiles(f, { '.github/workflows/ci.yml': shellWorkflow, '.github/workflows/release.yml': 'on: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n', '.gitlab-ci.yml': 'check:\n  script: echo ok\n' });
  const byPath = result => Object.fromEntries(result.configurations.map(item => [item.path, item]));
  const module = await value(await inspect(f)), listed = byPath(module);
  assert.deepEqual(module.configurations.map(item => item.path), ['.gitlab-ci.yml', '.github/workflows/ci.yml', '.github/workflows/release.yml']);
  assert.equal(module.executionAvailable, true); assert.deepEqual(module.diagnostics.map(d => d.code), ['module_profile']);
  assert.equal(module.configurations.some(item => item.manualPolicyAllowed || item.pushPolicyAllowed || item.diagnostics.some(d => d.code === 'not_approved_path')), false);
  assert.deepEqual({ ...listed['.github/workflows/ci.yml'], blobId: '' }, { path: '.github/workflows/ci.yml', blobId: '', byteSize: String(shellWorkflow.length), format: 'WORKFLOW_FORMAT_GITHUB_ACTIONS',
    state: 'WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET', name: 'Verify', jobs: [{ id: 'check', name: '', stage: '', stepCount: 1 }], events: ['pull_request'], diagnostics: [], manualPolicyAllowed: false, pushPolicyAllowed: false });
  assert.match(listed['.github/workflows/ci.yml'].blobId, /^[a-f0-9]{40}$/);
  assert.equal(listed['.github/workflows/release.yml'].state, 'WORKFLOW_INSPECTION_STATE_UNSUPPORTED');
  assert.deepEqual(listed['.github/workflows/release.yml'].diagnostics.map(d => d.code), ['outside_native_subset']); assert.deepEqual(listed['.github/workflows/release.yml'].jobs, []);
  assert.equal(listed['.gitlab-ci.yml'].format, 'WORKFLOW_FORMAT_GITLAB_CI'); assert.equal(listed['.gitlab-ci.yml'].state, 'WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET');
  assert.equal((await workflowReason(f)).reason, 'Lists workflow files at the default-branch commit. None can run: this installation executes one operator-approved Python test module on pull requests.');
  // The agent module may stay beside the approved Actions shell workflow.
  Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/ci.yml' });
  const workflow = await value(await inspect(f)), approved = byPath(workflow);
  assert.deepEqual(workflow.diagnostics, []); assert.notEqual(workflow.policyRevision, module.policyRevision);
  assert.deepEqual(workflow.configurations.map(item => [item.manualPolicyAllowed, item.pushPolicyAllowed]), [[false, false], [true, false], [false, false]]);
  assert.deepEqual(approved['.github/workflows/ci.yml'].diagnostics, []);
  assert.deepEqual(approved['.gitlab-ci.yml'].diagnostics.map(d => d.code), ['not_approved_path']);
  assert.deepEqual(approved['.github/workflows/release.yml'].diagnostics.map(d => d.code), ['outside_native_subset', 'not_approved_path']);
  f.env.CI_AUTO = 'true';
  const automatic = await value(await inspect(f));
  assert.equal(byPath(automatic)['.github/workflows/ci.yml'].pushPolicyAllowed, true); assert.notEqual(automatic.policyRevision, workflow.policyRevision);
  assert.equal((await workflowReason(f)).reason, 'Lists workflow files at the default-branch commit and marks the one operator-approved path that can run. Pull-request jobs only: one job of shell steps, no actions, expressions, services or matrices. No manual dispatch, branch-push or tag triggers.');
  f.env.TEST_WORKFLOW_PATH = '.github/workflows/absent.yml';
  const absent = await value(await inspect(f));
  assert.deepEqual(absent.diagnostics.map(d => d.code), ['approved_path_missing']); assert.equal(absent.configurations.some(item => item.manualPolicyAllowed), false);
  // The pinned catalog runs on customer runners; this page does not claim to have inspected its files.
  delete f.env.TEST_MODULE; Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'actions-act', TEST_WORKFLOW_PATH: '.github/workflows/release.yml' });
  const pinned = byPath(await value(await inspect(f)));
  assert.equal(pinned['.github/workflows/release.yml'].state, 'WORKFLOW_INSPECTION_STATE_UNSPECIFIED'); assert.deepEqual(pinned['.github/workflows/release.yml'].diagnostics.map(d => d.code), ['not_inspected']);
  assert.equal(pinned['.github/workflows/release.yml'].manualPolicyAllowed, true); assert.deepEqual(pinned['.github/workflows/ci.yml'].diagnostics.map(d => d.code), ['not_inspected', 'not_approved_path']);
  assert.match((await workflowReason(f)).reason, /selected customer runner pool with the pinned Actions catalog/);
  // An unallocated evidence queue removes every ceiling without hiding the inventory.
  delete f.env.EVIDENCE_BUCKET;
  const unallocated = await value(await inspect(f));
  assert.equal(unallocated.executionAvailable, false); assert.equal(unallocated.configurations.some(item => item.manualPolicyAllowed || item.pushPolicyAllowed), false);
});

test('workflow inventory bounds files, bytes and entry kinds and keeps the approved path listed', async t => {
  const f = await inventoryFixture(t); allocateEvidence(f); allocateTests(f);
  Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/zz.yml' });
  const many = workflowFiles(f, { ...Object.fromEntries(Array.from({ length: 25 }, (_, index) => ['.github/workflows/w' + String(index).padStart(2, '0') + '.yml', shellWorkflow])), '.github/workflows/zz.yml': shellWorkflow });
  const overfull = await value(await inspect(f));
  assert.equal(overfull.configurations.length, 20); assert.equal(many.reads(), 20);
  assert.deepEqual(overfull.configurations.map(item => item.path).slice(-2), ['.github/workflows/w18.yml', '.github/workflows/zz.yml']);
  assert.equal(overfull.configurations.at(-1).manualPolicyAllowed, true);
  assert.deepEqual(overfull.diagnostics, [{ code: 'inventory_truncated', message: '26 workflow files exist; 20 are listed.' }]);
  const g = await inventoryFixture(t);
  const kinds = workflowFiles(g, { '.github/workflows/big.yml': 'a'.repeat(64 * 1024 + 1), '.github/workflows/edge.yml': '#'.repeat(64 * 1024), '.github/workflows/binary.yaml': { source: new Uint8Array([0xff, 0xfe, 0x00]) },
    '.github/workflows/empty.yml': '', '.github/workflows/link.yml': { type: 'symlink', source: 'ci.yml' }, '.github/workflows/run.yml': { type: 'exec', source: shellWorkflow },
    '.github/workflows/bad\u0007name.yml': shellWorkflow, '.github/workflows/notes.txt': 'ignored', '.gitlab-ci.yml': { type: 'tree', source: '' } });
  const result = await value(await inspect(g)), listed = Object.fromEntries(result.configurations.map(item => [item.path.replace('.github/workflows/', ''), item]));
  assert.deepEqual(Object.keys(listed).sort(), ['.gitlab-ci.yml', 'big.yml', 'binary.yaml', 'edge.yml', 'empty.yml', 'link.yml', 'run.yml']);
  assert.equal(kinds.reads(), 4);
  assert.deepEqual([listed['big.yml'].state, listed['big.yml'].byteSize, listed['big.yml'].diagnostics[0].code], ['WORKFLOW_INSPECTION_STATE_UNSPECIFIED', '65537', 'file_too_large']);
  assert.deepEqual([listed['edge.yml'].state, listed['edge.yml'].byteSize, listed['edge.yml'].diagnostics[0].code], ['WORKFLOW_INSPECTION_STATE_UNSUPPORTED', '65536', 'outside_executable_size']);
  assert.deepEqual([listed['empty.yml'].state, listed['empty.yml'].diagnostics[0].code], ['WORKFLOW_INSPECTION_STATE_UNSUPPORTED', 'outside_executable_size']);
  assert.deepEqual([listed['binary.yaml'].state, listed['binary.yaml'].diagnostics[0].code], ['WORKFLOW_INSPECTION_STATE_INVALID', 'not_utf8']);
  for (const name of ['link.yml', 'run.yml', '.gitlab-ci.yml']) assert.deepEqual([listed[name].state, listed[name].blobId, listed[name].diagnostics[0].code], ['WORKFLOW_INSPECTION_STATE_UNSUPPORTED', '', 'not_regular_file']);
  assert.deepEqual(result.diagnostics.map(d => d.code), ['unlisted_names', 'module_profile']);
  // A syntactically valid GitLab job whose image admission would refuse is reported before anyone tries to run it.
  const h = await inventoryFixture(t); h.env.TEST_IMAGE_REF = 'alpine:3.23@sha256:' + 'b'.repeat(64);
  workflowFiles(h, { '.gitlab-ci.yml': `check:\n  image: alpine:3.23@sha256:${'a'.repeat(64)}\n  script: echo pinned\n` });
  const image = (await value(await inspect(h))).configurations[0];
  assert.deepEqual([image.state, image.diagnostics.map(d => d.code)], ['WORKFLOW_INSPECTION_STATE_VALIDATED_SUBSET', ['image_not_approved']]);
  h.env.TEST_IMAGE_REF = 'alpine:3.23@sha256:' + 'a'.repeat(64);
  assert.deepEqual((await value(await inspect(h))).configurations[0].diagnostics, []);
});

const policyCall = (f, method, body = {}, token = ownerToken) => f.call('', { scope: 'EXECUTION_SCOPE_REPOSITORY', repository: key, ...body }, token, '/rpc/golf.v1.ExecutionPolicyService/' + method);
// Changes need a verified human Access sign-in; this header stands in for the identity the public Worker forwards.
const humanPolicy = (f, method, body = {}, email = 'alice@example.com', headers = {}) => f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/rpc/golf.v1.ExecutionPolicyService/' + method, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', ...(email ? { 'X-Golf-Native-Access-Email': email } : {}), ...headers }, body: JSON.stringify({ scope: 'EXECUTION_SCOPE_REPOSITORY', repository: key, ...body }) }));
async function setExecution(f, manual, push) {
  f.sql.exec("UPDATE users SET email=login||'@example.com' WHERE email IS NULL");
  const { policy } = await value(await humanPolicy(f, 'GetExecutionPolicy'));
  return value(await humanPolicy(f, 'UpdateExecutionPolicy', { scopeId: policy.scopeId, expectedRevision: policy.revision, expectedAuthorityRevision: policy.authorityRevision,
    mode: manual || push ? 'EXECUTION_MODE_ALL' : 'EXECUTION_MODE_DISABLED', ...(manual ? { manualDispatchEnabled: true } : {}), ...(push ? { pushAllowed: true } : {}), allowAllWorkflows: true }));
}

test('the repository execution switch defaults to enabled and saves only under a current admin Access sign-in and the observed revision', async t => {
  const f = await inventoryFixture(t), origin = f.env.PUBLIC_ORIGIN, path = '/rpc/golf.v1.ExecutionPolicyService/';
  await value(await f.call('', { repository: key, repositoryId: '1', userId: '2', role: 'read' }, ownerToken, '/native/repository-grant'));
  f.sql.exec("UPDATE users SET email=login||'@example.com'");
  const initial = (await value(await humanPolicy(f, 'GetExecutionPolicy'))).policy;
  assert.deepEqual(initial, { scope: 'EXECUTION_SCOPE_REPOSITORY', scopeId: '1', ownerId: initial.ownerId, mode: 'EXECUTION_MODE_ALL', selectedRepositoryIds: [], manualDispatchEnabled: true, allowAllWorkflows: true,
    workflowPaths: [], revision: '0', revocationEpoch: '0', canEdit: true, authorityRevision: initial.authorityRevision, pushAllowed: true });
  assert.match(initial.ownerId, /^[1-9][0-9]*$/); assert.match(initial.authorityRevision, /^[a-f0-9]{64}$/);
  // A bearer credential reads the same switch and authority revision but is never offered the edit.
  assert.deepEqual((await value(await policyCall(f, 'GetExecutionPolicy'))).policy, { ...initial, canEdit: false });
  const reader = (await value(await humanPolicy(f, 'GetExecutionPolicy', {}, 'bob@example.com'))).policy;
  assert.deepEqual((await value(await policyCall(f, 'GetExecutionPolicy', {}, readerToken))).policy, reader);
  assert.equal(reader.canEdit, false); assert.equal(reader.manualDispatchEnabled, true); assert.notEqual(reader.authorityRevision, initial.authorityRevision);
  assert.equal((await f.dispatch(new Request(origin + path + 'GetExecutionPolicy', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ scope: 3, repository: key }) }))).status, 401);
  assert.equal((await policyCall(f, 'GetExecutionPolicy', { repository: { owner: 'alice', name: 'other' } })).status, 404);
  for (const body of [{ scope: 'EXECUTION_SCOPE_INSTANCE' }, { scope: 'EXECUTION_SCOPE_ORGANIZATION', organization: 'alice' }, { organization: 'alice' }, { repository: undefined }, { scope: undefined }]) assert.equal((await policyCall(f, 'GetExecutionPolicy', body)).status, 501);
  assert.equal((await policyCall(f, 'DeleteExecutionPolicy')).status, 501);
  const intent = (changes = {}) => ({ scopeId: '1', expectedRevision: '0', expectedAuthorityRevision: initial.authorityRevision, mode: 'EXECUTION_MODE_DISABLED', allowAllWorkflows: true, ...changes });
  const update = (changes = {}, email, headers) => humanPolicy(f, 'UpdateExecutionPolicy', intent(changes), email, headers);
  // The switch can stop a repository's CI: an admin bearer credential, a service token and a signed-in reader are all refused.
  assert.equal((await policyCall(f, 'UpdateExecutionPolicy', intent())).status, 404);
  for (const headers of [{ Authorization: 'Bearer ' + ownerToken }, { 'CF-Access-Client-Id': 'machine' }, { 'CF-Access-Client-Secret': 'secret' }]) assert.ok([401, 404].includes((await update({}, 'alice@example.com', headers)).status), JSON.stringify(headers));
  assert.equal((await update({}, '')).status, 401);
  assert.equal((await update({ expectedAuthorityRevision: reader.authorityRevision }, 'bob@example.com')).status, 404);
  assert.equal((await policyCall(f, 'UpdateExecutionPolicy', intent({ expectedAuthorityRevision: reader.authorityRevision }), readerToken)).status, 404);
  assert.equal((await update({ scopeId: '2' })).status, 404);
  for (const changes of [{ mode: 'EXECUTION_MODE_SELECTED', selectedRepositoryIds: ['1'] }, { mode: 'EXECUTION_MODE_SELECTED' }, { workflowPaths: ['.github/workflows/ci.yml'] }, { allowAllWorkflows: false }, { mode: 'EXECUTION_MODE_ALL' },
    { manualDispatchEnabled: true }, { pushAllowed: 'true' }, { revocationEpoch: '1' }, { expectedRevision: 'latest' }, { expectedAuthorityRevision: 'current' }]) assert.equal((await update(changes)).status, 400, JSON.stringify(changes));
  assert.equal((await update({ expectedRevision: '1' })).status, 412);
  assert.equal((await update({ expectedAuthorityRevision: 'f'.repeat(64) })).status, 412);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM repository_execution_policy').get().n, 0);
  const disabled = (await value(await update())).policy;
  assert.deepEqual([disabled.mode, disabled.manualDispatchEnabled, disabled.pushAllowed, disabled.revision, disabled.revocationEpoch, disabled.authorityRevision], ['EXECUTION_MODE_DISABLED', false, false, '1', '0', initial.authorityRevision]);
  assert.deepEqual({ ...f.sql.prepare('SELECT repository_id,version,manual,push,updated_by FROM repository_execution_policy').get() }, { repository_id: 1, version: 1, manual: 0, push: 0, updated_by: 1 });
  // The first observation cannot be replayed over a later one.
  assert.equal((await update({ mode: 'EXECUTION_MODE_ALL', manualDispatchEnabled: true })).status, 412);
  const pushOnly = (await value(await update({ expectedRevision: '1', mode: 'EXECUTION_MODE_ALL', pushAllowed: true }))).policy;
  assert.deepEqual([pushOnly.mode, pushOnly.manualDispatchEnabled, pushOnly.pushAllowed, pushOnly.revision], ['EXECUTION_MODE_ALL', false, true, '2']);
  // Losing admin between the read and the write leaves the stored switch untouched.
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = function (query) { if (query.startsWith('INSERT INTO repository_execution_policy')) f.sql.exec("UPDATE grants SET role='write' WHERE repository_id=1 AND user_id=1"); return prepare.call(this, query); };
  assert.equal((await update({ expectedRevision: '2', mode: 'EXECUTION_MODE_ALL', manualDispatchEnabled: true, pushAllowed: true })).status, 412);
  f.env.DB.prepare = prepare;
  assert.deepEqual({ ...f.sql.prepare('SELECT version,manual,push FROM repository_execution_policy').get() }, { version: 2, manual: 0, push: 1 });
  assert.equal((await value(await humanPolicy(f, 'GetExecutionPolicy'))).policy.canEdit, false);
  // A row recorded for another artifact enables nothing.
  f.sql.exec("UPDATE repository_execution_policy SET artifact_name='repo-other',manual=1");
  const foreign = (await value(await policyCall(f, 'GetExecutionPolicy'))).policy;
  assert.deepEqual([foreign.mode, foreign.manualDispatchEnabled, foreign.pushAllowed], ['EXECUTION_MODE_DISABLED', false, false]);
  assert.equal(concurrentRead(new Request(origin + path + 'GetExecutionPolicy', { method: 'POST' })), true);
  assert.equal(concurrentRead(new Request(origin + path + 'UpdateExecutionPolicy', { method: 'POST' })), false);
});

test('a repository that turns runs off refuses new admission, marks automatic intake refused and leaves admitted work and agents alone', async t => {
  const f = await evidenceFixture(t), input = { ...f.input, advice: false, runTests: true };
  allocateAgents(f); Object.assign(f.env, { CI_AUTO: 'true', EVIDENCE_DAILY_LIMIT: '20' });
  const capability = async () => (await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.find(c => c.id === 'settings.repository-execution-policy');
  assert.deepEqual([(await capability()).state, (await capability()).reason], ['CAPABILITY_STATE_DISABLED', 'The repository execution switch is changed only under a verified Access sign-in, which this installation does not configure.']);
  f.env.ACCESS_AUD = 'access-aud';
  assert.equal((await capability()).state, 'CAPABILITY_STATE_READY'); assert.match((await capability()).reason, /Changes need a verified Access sign-in\./);
  const jobs = () => f.sql.prepare('SELECT count(*) AS n FROM evidence_jobs').get().n;
  const pushed = () => f.sql.prepare('INSERT INTO git_operations(id,repository_id,user_id,ref,old_sha,new_sha,state,ci_state,created_at) VALUES(?,1,1,?,?,?,?,?,?) RETURNING id')
    .get(nonce(), 'refs/heads/feature', commit, 'b'.repeat(40), 'APPLIED', 'PENDING', new Date().toISOString()).id;
  const admitted = (await value(await f.evidence(input))).job;
  assert.equal((await setExecution(f, false, true)).policy.manualDispatchEnabled, false);
  const refused = await f.evidence({ ...input, idempotencyKey: nonce() });
  assert.equal(refused.status, 412); assert.deepEqual(await refused.json(), { code: 'failed_precondition', message: 'Pull-request runs are turned off for this repository.' });
  assert.equal(jobs(), 1); assert.equal(f.messages.length, 1);
  // The switch is an admission rule: the original run is still readable, replayable and running.
  assert.equal((await value(await f.evidence(input))).job.id, admitted.id);
  assert.equal((await f.advance(admitted.id, 'tests')).state, 'RUNNING'); assert.equal(f.sql.prepare('SELECT test_state FROM evidence_jobs WHERE id=?').get(admitted.id).test_state, 'RUNNING');
  assert.equal((await f.advance(admitted.id, 'authorize-test')).state, 'AUTHORIZED');
  // Evidence without tests and agent proposals are not governed by it.
  assert.equal((await f.evidence({ ...f.input, advice: false, idempotencyKey: nonce() })).status, 200);
  assert.equal((await value(await f.evidence({ ...f.input, advice: false, agent: { prompt: 'Improve the approved source file.' }, idempotencyKey: nonce() }))).job.agentState, 'REQUESTED');
  // Automatic push tests have their own switch and still admit.
  const first = pushed();
  assert.deepEqual(await runCI(f.env), { admitted: 1 });
  assert.deepEqual({ ...f.sql.prepare('SELECT state,reason FROM ci_intake WHERE operation_id=?').get(first) }, { state: 'ADMITTED', reason: null });
  assert.equal((await setExecution(f, true, false)).policy.pushAllowed, false);
  const second = pushed(), admissions = jobs();
  assert.deepEqual(await runCI(f.env), { admitted: 0 });
  assert.equal(f.sql.prepare('SELECT ci_state FROM git_operations WHERE id=?').get(second).ci_state, 'REFUSED');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM ci_intake WHERE operation_id=?').get(second).n, 0);
  // Intake recorded while enabled is refused, not silently dropped, once the switch is off.
  const third = pushed(), intake = nonce();
  f.sql.prepare("UPDATE git_operations SET ci_state='RECORDED' WHERE id=?").run(third);
  f.sql.prepare('INSERT INTO ci_intake(id,operation_id,repository_id,user_id,number,selection,created_at) VALUES(?,?,1,1,?,?,?)').run(intake, third, f.selection.number, JSON.stringify(f.selection), new Date().toISOString());
  assert.deepEqual(await runCI(f.env), { admitted: 0 });
  assert.deepEqual({ ...f.sql.prepare('SELECT state,reason,job_id FROM ci_intake WHERE id=?').get(intake) }, { state: 'REFUSED', reason: 'failed_precondition', job_id: null });
  assert.equal(jobs(), admissions);
  // A writer's own run is allowed again, and the inventory reports the same switch.
  assert.equal((await f.evidence({ ...input, idempotencyKey: nonce() })).status, 200);
  await setExecution(f, false, false);
  assert.equal((await f.evidence({ ...input, idempotencyKey: nonce() })).status, 412);
  delete f.env.EVIDENCE_BUCKET;
  assert.deepEqual([(await capability()).state, (await capability()).reason], ['CAPABILITY_STATE_DISABLED', 'Pull-request test execution is not allocated on this installation; a repository switch has nothing to govern.']);
});

test('the workflow inventory reports the repository switch beside the operator allocation', async t => {
  const f = await inventoryFixture(t); allocateEvidence(f); allocateTests(f);
  Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: '.github/workflows/ci.yml', CI_AUTO: 'true' });
  workflowFiles(f, { '.github/workflows/ci.yml': shellWorkflow });
  const flags = async () => { const result = await value(await inspect(f)); return [result.configurations[0].manualPolicyAllowed, result.configurations[0].pushPolicyAllowed, result.policyRevision]; };
  const enabled = await flags(); assert.deepEqual(enabled.slice(0, 2), [true, true]);
  await setExecution(f, false, true);
  const pushOnly = await flags(); assert.deepEqual(pushOnly.slice(0, 2), [false, true]); assert.notEqual(pushOnly[2], enabled[2]);
  await setExecution(f, false, false);
  assert.deepEqual((await flags()).slice(0, 2), [false, false]);
  await setExecution(f, true, true);
  const restored = await flags(); assert.deepEqual(restored.slice(0, 2), [true, true]); assert.notEqual(restored[2], enabled[2]);
});

test('recent repository runs come from stored rows for current repository accounts, bounded and without a Git read', async t => {
  const f = await evidenceFixture(t); allocateAgents(f); f.env.EVIDENCE_DAILY_LIMIT = '20';
  const list = (body = {}, token = ownerToken, path = '/native/pr-evidence/read') => f.call('', { action: 'list', repository: key, repositoryId: '1', ...body }, token, path);
  assert.deepEqual(await value(await list()), { jobs: [], truncated: false });
  const tests = (await value(await f.evidence({ ...f.input, advice: false, runTests: true }))).job;
  const agent = (await value(await f.evidence({ ...f.input, advice: false, agent: { prompt: 'A private agent prompt.' }, idempotencyKey: nonce() }))).job;
  const open = f.env.ARTIFACTS.get, fetches = globalThis.fetch.mock.callCount(); let opens = 0;
  f.env.ARTIFACTS.get = name => { opens++; return open(name); };
  const recent = await value(await list({}, readerToken));
  assert.equal(opens, 0); assert.equal(globalThis.fetch.mock.callCount(), fetches);
  assert.deepEqual(recent.jobs.map(job => job.id).sort(), [tests.id, agent.id].sort()); assert.equal(recent.truncated, false);
  const { updatedAt, ...row } = recent.jobs.find(job => job.id === tests.id);
  assert.deepEqual(row, { id: tests.id, state: 'QUEUED', selection: f.selection, createdAt: tests.createdAt, expiresAt: tests.expiresAt, advisoryOnly: true, adviceState: 'NONE', testState: 'REQUESTED', agentState: 'NONE' });
  assert.equal(recent.jobs.find(job => job.id === agent.id).agentState, 'REQUESTED');
  // The repository-wide rows make no staleness claim and carry no snapshot content.
  assert.equal(recent.jobs.some(job => 'stale' in job || 'idempotencyKey' in job), false); assert.equal(JSON.stringify(recent).includes('private agent prompt'), false);
  assert.deepEqual(await value(await list({}, ownerToken, '/native/pr-evidence')), recent);
  // A pull request's own list still observes current source once.
  const perPull = await value(await list({ number: f.selection.number }, readerToken));
  assert.equal(perPull.jobs.length, 2); assert.equal(perPull.jobs.every(job => job.stale === false), true); assert.ok(opens > 0);
  for (const number of [0, -1, 1.5, '1', null]) assert.equal((await list({ number })).status, 400);
  // Newest first, at most 50, and an honest truncation flag.
  const insert = f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,test_state,agent_state,created_at,updated_at,expires_at) VALUES(?,1,1,?,'hash',?,'NONE','PASSED','NONE',?,?,?)");
  for (let index = 0; index < 55; index++) { const time = new Date(Date.UTC(2031, 0, 1, 0, index)).toISOString(); insert.run(nonce(), nonce(), JSON.stringify({ selection: { ...f.selection, number: index + 10 } }), time, time, time); }
  const bounded = await value(await list());
  assert.equal(bounded.jobs.length, 50); assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.jobs.slice(0, 2).map(job => job.selection.number), [64, 63]); assert.equal(bounded.jobs.at(-1).selection.number, 15);
  // No grant, no inventory: neither a former reader nor an anonymous caller, even on a published repository.
  f.env.PUBLIC_REPOSITORIES = 'true'; f.sql.exec('INSERT INTO repository_visibility(repository_id,is_public) VALUES(1,1)');
  f.sql.prepare('DELETE FROM grants WHERE repository_id=1 AND user_id=2').run();
  assert.equal((await list({}, readerToken)).status, 404);
  assert.equal((await f.dispatch(new Request(f.env.PUBLIC_ORIGIN + '/native/pr-evidence/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify({ action: 'list', repository: key, repositoryId: '1' }) }))).status, 401);
});

async function executionValueFixture(t) {
  const f = await evidenceFixture(t), execution = allocateTests(f), blobId = '9'.repeat(40), path = '.github/workflows/check.yml';
  delete f.env.TEST_MODULE;
  Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: path, TEST_POLICY_SHA256: '8'.repeat(64), EXECUTION_VALUE_KEY: { get: async () => Buffer.alloc(32, 9).toString('base64') } });
  f.sql.exec("UPDATE users SET email=login||'@example.com'");
  const state = { source: 'on: pull_request\njobs:\n  check:\n    runs-on: golf-native-linux\n    steps:\n      - run: ./check.sh\n' };
  const trees = { ['f'.repeat(40)]: { name: '.github', hash: '7'.repeat(40), type: 'tree' }, ['7'.repeat(40)]: { name: 'workflows', hash: '8'.repeat(40), type: 'tree' }, ['8'.repeat(40)]: { name: 'check.yml', hash: blobId, type: 'blob' } };
  const get = f.env.ARTIFACTS.get;
  f.env.ARTIFACTS.get = async name => {
    const repo = await get(name), readTree = repo.readTree, readBlob = repo.readBlob;
    return { ...repo,
      async readTree(hash) { const entries = await readTree(hash); return trees[hash] ? [...(entries || []), trees[hash]] : entries; },
      async readBlob(hash) { return hash === blobId ? new Blob([state.source]) : readBlob(hash); } };
  };
  const service = '/rpc/golf.v1.RepositoryExecutionValueService/';
  const access = async (token = ownerToken) => (await value(await f.call('', { repository: key }, token, '/rpc/golf.v1.RepositoryAccessService/GetRepositoryAccess'))).access.revision;
  const target = async token => ({ repository: key, repositoryId: '1', ownerId: '1', accessRevision: await access(token) });
  const human = async (method, body = {}, email = 'alice@example.com', token = ownerToken, headers = {}) => f.dispatch(new Request(f.env.PUBLIC_ORIGIN + service + method, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Origin: f.env.PUBLIC_ORIGIN, ...(email ? { 'X-Golf-Native-Access-Email': email } : {}), ...headers }, body: JSON.stringify({ target: await target(token), ...body }) }));
  const list = async () => value(await human('ListRepositoryExecutionValues'));
  const save = async (name, text, fields = {}) => human('SaveRepositoryExecutionValue', { id: nonce(), expectedVersion: '0', expectedBrokerRevision: (await list()).brokerRevision, operationId: nonce(), name, kind: 'REPOSITORY_EXECUTION_VALUE_KIND_SECRET', value: text, ...fields });
  const approve = async (values, fields = {}) => human('SaveRepositoryExecutionBinding', { id: nonce(), expectedVersion: '0', expectedBrokerRevision: (await list()).brokerRevision, operationId: nonce(), workflowPath: path, commitId: 'b'.repeat(40),
    event: 'WORKFLOW_RUN_ORIGIN_PULL_REQUEST', eventRef: 'refs/heads/feature', expiresAt: new Date(Date.now() + 900000).toISOString(), values: values.map(v => ({ id: v.id, version: v.version, scope: 'EXECUTION_VALUE_SCOPE_REPOSITORY' })), ...fields });
  // Every cell D1 holds, for assertions that a plaintext is stored nowhere.
  const stored = () => JSON.stringify(f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(table => f.sql.prepare('SELECT * FROM ' + table.name).all()));
  return { ...f, execution, blobId, path, state, human, list, save, approve, stored, service };
}
const refusedBeforeCommit = async (response, status) => { assert.equal(response.status, status, await response.clone().text()); assert.equal(response.headers.get('Golf-Execution-Effect'), 'none'); };

test('repository values keep only ciphertext, never return a secret and replay only the original request', async t => {
  const f = await executionValueFixture(t), secret = 'fixture-secret-not-a-real-credential';
  const input = { id: nonce(), expectedVersion: '0', expectedBrokerRevision: '0', operationId: nonce(), name: 'DEPLOY_TOKEN', kind: 'REPOSITORY_EXECUTION_VALUE_KIND_SECRET', value: secret };
  const saved = await f.human('SaveRepositoryExecutionValue', input);
  assert.equal(saved.headers.get('Golf-Execution-Effect'), null);
  const receipt = (await value(saved)).operation;
  assert.deepEqual([receipt.action, receipt.itemId, receipt.acceptedVersion, receipt.acceptedBrokerRevision, receipt.replayed], ['save_value', input.id, '1', '1', false]);
  assert.equal(f.stored().includes(secret), false); assert.equal(JSON.stringify(receipt).includes(secret), false);
  const version = f.sql.prepare('SELECT * FROM execution_value_versions').get();
  assert.match(version.encrypted, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/); assert.match(version.key_id, /^[a-f0-9]{16}$/); assert.equal(version.value_bytes, secret.length);
  const listed = await f.list();
  assert.deepEqual([listed.brokerRevision, listed.maximumValues, listed.maximumBindings, listed.consumerProfile], ['1', 64, 20, 'golf.repository-env.v1']);
  assert.deepEqual(listed.values.map(v => [v.name, v.kind, v.version, v.deleted]), [['DEPLOY_TOKEN', 'REPOSITORY_EXECUTION_VALUE_KIND_SECRET', '1', false]]);
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal((await f.human('GetRepositoryExecutionVariable', { id: input.id, version: '1' })).status, 404);
  const replayed = (await value(await f.human('SaveRepositoryExecutionValue', input))).operation;
  assert.deepEqual([replayed.acceptedVersion, replayed.acceptedBrokerRevision, replayed.replayed, replayed.committedAt], ['1', '1', true, receipt.committedAt]);
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, value: 'another-fixture-secret' }), 409);
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, value: secret + 'x' }), 409);
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, name: 'OTHER_TOKEN' }), 409);
  await refusedBeforeCommit(await f.human('DeleteRepositoryExecutionValue', { ...input, expectedVersion: '1', expectedBrokerRevision: '1' }), 409);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM execution_value_versions').get().n, 1);
  assert.equal((await value(await f.human('GetRepositoryExecutionValueOperation', { operationId: input.operationId }))).operation.acceptedVersion, '1');
  assert.equal((await f.human('GetRepositoryExecutionValueOperation', { operationId: nonce() })).status, 404);
  const variable = { ...input, id: nonce(), operationId: nonce(), expectedBrokerRevision: '1', name: 'REGION', kind: 'REPOSITORY_EXECUTION_VALUE_KIND_VARIABLE', value: 'eu-central' };
  await value(await f.human('SaveRepositoryExecutionValue', variable));
  assert.equal(f.stored().includes('eu-central'), false);
  assert.equal((await value(await f.human('GetRepositoryExecutionVariable', { id: variable.id, version: '1' }))).value, 'eu-central');
  assert.equal((await f.human('GetRepositoryExecutionVariable', { id: variable.id, version: '2' })).status, 404);
  const rotated = (await value(await f.human('SaveRepositoryExecutionValue', { ...input, operationId: nonce(), expectedVersion: '1', expectedBrokerRevision: '2', value: 'rotated-fixture-secret' }))).operation;
  assert.deepEqual([rotated.acceptedVersion, rotated.acceptedBrokerRevision], ['2', '3']);
  // After a rotation the first receipt still answers only for the text it sealed.
  assert.equal((await value(await f.human('SaveRepositoryExecutionValue', input))).operation.replayed, true);
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, value: 'rotated-fixture-secret' }), 409);
  const removed = (await value(await f.human('DeleteRepositoryExecutionValue', { id: input.id, expectedVersion: '2', expectedBrokerRevision: '3', operationId: nonce() }))).operation;
  assert.deepEqual([removed.action, removed.acceptedVersion], ['delete_value', '3']);
  assert.deepEqual((await f.list()).values.map(v => [v.name, v.deleted, v.version]), [['DEPLOY_TOKEN', true, '3'], ['REGION', false, '1']]);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM execution_value_versions WHERE id=?').get(input.id).n, 2);
  assert.equal(f.stored().includes('rotated-fixture-secret'), false);
});

test('repository values refuse readers, writers, bearer and service credentials and stale observations', async t => {
  const f = await executionValueFixture(t), secret = 'fixture-secret-not-a-real-credential';
  const input = { id: nonce(), expectedVersion: '0', expectedBrokerRevision: '0', operationId: nonce(), name: 'DEPLOY_TOKEN', kind: 'REPOSITORY_EXECUTION_VALUE_KIND_SECRET', value: secret };
  for (const role of ['read', 'write']) {
    f.sql.prepare('UPDATE grants SET role=? WHERE user_id=2').run(role);
    for (const [method, body] of [['ListRepositoryExecutionValues', {}], ['SaveRepositoryExecutionValue', input], ['GetRepositoryExecutionVariable', { id: input.id, version: '1' }], ['GetRepositoryExecutionValueOperation', { operationId: input.operationId }]])
      assert.equal((await f.human(method, body, 'bob@example.com', readerToken)).status, 404, role + ' ' + method);
  }
  const bearer = await f.call('', { target: { repository: key, repositoryId: '1', ownerId: '1', accessRevision: 'a'.repeat(64) }, ...input }, ownerToken, f.service + 'SaveRepositoryExecutionValue');
  await refusedBeforeCommit(bearer, 404);
  assert.equal((await f.human('ListRepositoryExecutionValues', {}, 'alice@example.com', ownerToken, { Authorization: 'Bearer ' + ownerToken })).status, 404);
  assert.equal((await f.human('ListRepositoryExecutionValues', {}, 'alice@example.com', ownerToken, { 'CF-Access-Client-Id': 'service.access' })).status, 404);
  assert.equal((await f.human('ListRepositoryExecutionValues', {}, '')).status, 401);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM execution_values').get().n, 0);
  const call = (method, body) => f.dispatch(new Request(f.env.PUBLIC_ORIGIN + f.service + method, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': 'alice@example.com' }, body: JSON.stringify(body) }));
  const target = { repository: key, repositoryId: '1', ownerId: '1' };
  await refusedBeforeCommit(await call('SaveRepositoryExecutionValue', { target: { ...target, accessRevision: 'a'.repeat(64) }, ...input }), 412);
  await refusedBeforeCommit(await call('SaveRepositoryExecutionValue', { target: { ...target, ownerId: '2' }, ...input }), 404);
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, expectedBrokerRevision: '1' }), 409);
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, expectedVersion: '1' }), 409);
  await value(await f.human('SaveRepositoryExecutionValue', input));
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, operationId: nonce(), expectedVersion: '1', expectedBrokerRevision: '0' }), 409);
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, operationId: nonce(), expectedVersion: '0', expectedBrokerRevision: '1' }), 409);
  await refusedBeforeCommit(await f.human('DeleteRepositoryExecutionValue', { id: input.id, operationId: nonce(), expectedVersion: '2', expectedBrokerRevision: '1' }), 409);
  // Bob becomes an administrator: he may manage values, but another person's operation ID is not his to read or reuse.
  f.sql.prepare("UPDATE grants SET role='admin' WHERE user_id=2").run();
  assert.equal((await f.human('GetRepositoryExecutionValueOperation', { operationId: input.operationId }, 'bob@example.com', readerToken)).status, 404);
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', input, 'bob@example.com', readerToken), 404);
  // Authority lost between the request's checks and its write changes nothing.
  const get = f.env.EXECUTION_VALUE_KEY.get;
  f.env.EXECUTION_VALUE_KEY.get = async () => { f.sql.exec("UPDATE grants SET role='write' WHERE user_id=1"); return get(); };
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { ...input, id: nonce(), operationId: nonce(), name: 'LATE_TOKEN', expectedBrokerRevision: '1' }), 409);
  assert.deepEqual(f.sql.prepare('SELECT name FROM execution_values').all().map(v => v.name), ['DEPLOY_TOKEN']);
  assert.equal(f.sql.prepare('SELECT revision FROM execution_value_brokers').get().revision, 1);
});

test('repository values enforce the portable limits and the native reserved names', async t => {
  const f = await executionValueFixture(t);
  for (const name of ['PATH', 'HOME', 'CI', 'TRACE', 'PS4', 'SHELLOPTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'GIT_CONFIG_KEY_0', 'GOLF_REGISTRY', 'GOLF_COMMIT', 'CI_JOB_STATUS', 'CI_DEBUG_TRACE', 'FF_SCRIPT_SECTIONS', 'GITLAB_TOKEN', 'GITHUB_TOKEN', 'BASH_ENV', 'LD_PRELOAD', 'lower', '1LEADING', 'HAS-DASH', 'A'.repeat(65), ''])
    await refusedBeforeCommit(await f.save(name, 'fixture-secret-value'), 400);
  for (const text of ['short77', 'x'.repeat(8193), 'two\nlines-of-text', 'nul\u0000inside-text', 'separator inside', 'lone\ud800surrogate', '', 7])
    await refusedBeforeCommit(await f.save('DEPLOY_TOKEN', text), 400);
  await refusedBeforeCommit(await f.save('DEPLOY_TOKEN', 'fixture-secret-value', { kind: 'REPOSITORY_EXECUTION_VALUE_KIND_UNSPECIFIED' }), 400);
  await refusedBeforeCommit(await f.save('DEPLOY_TOKEN', 'fixture-secret-value', { id: 'not-a-uuid' }), 400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM execution_values').get().n, 0);
  await value(await f.save('EDGE_SECRET', 'é'.repeat(4096)));
  await value(await f.save('EDGE_VARIABLE', 'v', { kind: 2 }));
  await refusedBeforeCommit(await f.save('EDGE_SECRET', 'fixture-secret-value'), 400);
  // 64 KiB of active values: six more full-size values fit, a seventh does not, and then not one byte more.
  for (let i = 0; i < 6; i++) await value(await f.save('FULL_' + i, 'x'.repeat(8192)));
  await refusedBeforeCommit(await f.save('OVER_BUDGET', 'x'.repeat(8192)), 400);
  await value(await f.save('LAST_BYTES', 'x'.repeat(8191)));
  await refusedBeforeCommit(await f.save('ONE_MORE', 'x', { kind: 2 }), 400);
  for (const v of (await f.list()).values.filter(v => v.name.startsWith('FULL_')))
    await value(await f.human('DeleteRepositoryExecutionValue', { id: v.id, expectedVersion: v.version, expectedBrokerRevision: (await f.list()).brokerRevision, operationId: nonce() }));
  for (let i = 0; i < 55; i++) await value(await f.save('NAME_' + i, 'fixture-secret-value'));
  assert.equal((await f.list()).values.length, 64);
  // Removed names keep their slot, as on the portable broker.
  await refusedBeforeCommit(await f.save('NAME_65', 'fixture-secret-value'), 400);
  const edge = (await f.list()).values.find(v => v.name === 'EDGE_VARIABLE');
  let version = Number(edge.version);
  for (let history = f.sql.prepare('SELECT COUNT(*) n FROM execution_value_versions').get().n; history < 256; history++, version++)
    await value(await f.save('EDGE_VARIABLE', 'v' + history, { id: edge.id, kind: 2, expectedVersion: String(version) }));
  await refusedBeforeCommit(await f.save('EDGE_VARIABLE', 'one-too-many', { id: edge.id, kind: 2, expectedVersion: String(version) }), 400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM execution_value_versions').get().n, 256);
});

test('repository value ciphertext is bound to its installation, repository, value, version, name, kind and length', async t => {
  const f = await executionValueFixture(t);
  await value(await f.save('FIRST_VALUE', 'first-variable-text', { kind: 2 })); await value(await f.save('SECOND_VALUE', 'second-variable-text', { kind: 2 }));
  const [first, second] = (await f.list()).values, read = () => f.human('GetRepositoryExecutionVariable', { id: first.id, version: '1' });
  const original = f.sql.prepare('SELECT encrypted FROM execution_value_versions WHERE id=?').get(first.id).encrypted;
  const readable = async () => assert.equal((await value(await read())).value, 'first-variable-text');
  const unreadable = async () => { const response = await read(); assert.equal(response.status, 503); assert.equal((await response.text()).includes('variable-text'), false); };
  await readable();
  f.sql.prepare('UPDATE execution_value_versions SET encrypted=(SELECT encrypted FROM execution_value_versions WHERE id=?) WHERE id=?').run(second.id, first.id); await unreadable();
  f.sql.prepare('UPDATE execution_value_versions SET encrypted=? WHERE id=?').run(original, first.id); await readable();
  f.sql.prepare("UPDATE execution_values SET name='RENAMED' WHERE id=?").run(first.id); await unreadable();
  f.sql.prepare("UPDATE execution_values SET name='FIRST_VALUE' WHERE id=?").run(first.id); await readable();
  f.sql.prepare('UPDATE execution_value_versions SET value_bytes=value_bytes+1 WHERE id=?').run(first.id); await unreadable();
  f.sql.prepare('UPDATE execution_value_versions SET value_bytes=value_bytes-1 WHERE id=?').run(first.id); await readable();
  // A later version of the same value cannot be served from an earlier ciphertext.
  f.sql.prepare('UPDATE execution_values SET version=2 WHERE id=?').run(first.id);
  f.sql.prepare('UPDATE execution_value_versions SET version=2 WHERE id=?').run(first.id);
  const later = await f.human('GetRepositoryExecutionVariable', { id: first.id, version: '2' }); assert.equal(later.status, 503);
  f.sql.prepare('UPDATE execution_value_versions SET version=1 WHERE id=?').run(first.id);
  f.sql.prepare('UPDATE execution_values SET version=1 WHERE id=?').run(first.id); await readable();
  // The same rows under another repository identity or another installation origin do not open.
  const artifact = f.sql.prepare('SELECT artifact_name FROM repositories WHERE id=1').get().artifact_name, renamed = name => f.sql.exec(`UPDATE repositories SET artifact_name='${name}'; UPDATE execution_values SET artifact_name='${name}'`);
  renamed('repo-' + '0'.repeat(32)); await unreadable(); renamed(artifact); await readable();
  f.env.PUBLIC_ORIGIN = 'https://other.example.com'; await unreadable();
  f.env.PUBLIC_ORIGIN = 'https://golf.example.com'; await readable();
  // A different key is named before any decryption is attempted, and an unusable key reads nothing.
  f.env.EXECUTION_VALUE_KEY = { get: async () => Buffer.alloc(32, 3).toString('base64') }; await unreadable();
  f.env.EXECUTION_VALUE_KEY = { get: async () => 'not-a-key' }; await unreadable();
  f.env.EXECUTION_VALUE_KEY = { get: async () => Buffer.alloc(32, 9).toString('base64') }; await readable();
});

test('exact-source approvals bind the approved workflow, commit and head branch under current administrator authority', async t => {
  const f = await executionValueFixture(t);
  await value(await f.save('DEPLOY_TOKEN', 'fixture-secret-value')); await value(await f.save('REGION', 'eu-central', { kind: 2 }));
  const values = (await f.list()).values, ref = { id: values[0].id, version: values[0].version };
  for (const fields of [{ event: 'WORKFLOW_RUN_ORIGIN_MANUAL', eventRef: '' }, { event: 'WORKFLOW_RUN_ORIGIN_MANUAL' }, { event: 1 }, { event: 'WORKFLOW_RUN_ORIGIN_PUSH' }, { event: 2 }, { event: undefined }, { event: 4 }, { eventRef: 'refs/tags/v1' }, { eventRef: 'feature' }, { eventRef: 'refs/heads/a..b' },
    { workflowPath: '.github/workflows/other.yml' }, { workflowPath: '.gitlab-ci.yml' }, { commitId: 'B'.repeat(40) }, { commitId: 'd'.repeat(40) }, { workflowBlobId: 'short' },
    { expiresAt: new Date(Date.now() + 30000).toISOString() }, { expiresAt: new Date(Date.now() + 86460000).toISOString() }, { expiresAt: 'tomorrow' }, { expiresAt: Date.now() + 900000 },
    { inputs: [{ name: 'tier', stringValue: 'deploy' }] }, { inputContract: 'golf.workflow.dispatch.inputs.v1' }, { schemaSha256: 'e'.repeat(64) }, { submittedSha256: 'e'.repeat(64) }, { effectiveSha256: 'e'.repeat(64) },
    { values: [] }, { values: [ref, ref] }, { values: [{ ...ref, scope: 'EXECUTION_VALUE_SCOPE_ORGANIZATION' }] }, { values: [{ ...ref, organizationId: '1' }] }, { values: [{ ...ref, version: '0' }] }, { values: [{ id: 'x', version: '1' }] }])
    await refusedBeforeCommit(await f.approve(values, fields), 400);
  for (const fields of [{ values: [{ ...ref, version: '2' }] }, { values: [{ id: nonce(), version: '1' }] }, { workflowBlobId: '1'.repeat(40) }, { expectedVersion: '1' }, { expectedBrokerRevision: '9' }])
    await refusedBeforeCommit(await f.approve(values, fields), 409);
  const supported = f.state.source;
  // What an approval covers must be a workflow the hosted lane can run, read from the approved commit itself.
  for (const source of ['on: push\njobs:\n  check:\n    runs-on: golf-native-linux\n    steps:\n      - run: ./check.sh\n', 'on: pull_request\njobs:\n  check:\n    runs-on: golf-native-linux\n    steps:\n      - run: echo ${{ secrets.DEPLOY_TOKEN }}\n']) {
    f.state.source = source; await refusedBeforeCommit(await f.approve(values), 400);
  }
  f.state.source = supported;
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM execution_bindings').get().n, 0);
  const input = { id: nonce(), operationId: nonce() }, approved = (await value(await f.approve(values, input))).operation;
  assert.deepEqual([approved.action, approved.itemId, approved.acceptedVersion, approved.acceptedBrokerRevision, approved.replayed], ['save_binding', input.id, '1', '3', false]);
  const [binding] = (await f.list()).bindings;
  assert.deepEqual([binding.id, binding.version, binding.workflowPath, binding.commitId, binding.workflowBlobId, binding.engineCatalog, binding.event, binding.eventRef, binding.deleted, binding.approvalState],
    [input.id, '1', f.path, 'b'.repeat(40), f.blobId, 'golf.native.workflow-shell.v1', 'WORKFLOW_RUN_ORIGIN_PULL_REQUEST', 'refs/heads/feature', false, 'requires_current_authority']);
  assert.equal(f.sql.prepare('SELECT event FROM execution_bindings').get().event, 'pull_request');
  assert.match(binding.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(binding.values.map(v => [v.id, v.version, v.scope]).sort(), values.map(v => [v.id, v.version, 'EXECUTION_VALUE_SCOPE_REPOSITORY']).sort());
  assert.equal(f.sql.prepare('SELECT sponsor_id FROM execution_bindings').get().sponsor_id, 1);
  // Replaying the original request needs its original fields; the receipt never moves to another source.
  const first = { id: input.id, operationId: input.operationId, expectedBrokerRevision: '2', expiresAt: binding.expiresAt };
  assert.equal((await value(await f.approve(values, first))).operation.replayed, true);
  await refusedBeforeCommit(await f.approve(values, { ...first, commitId: commit }), 409);
  await refusedBeforeCommit(await f.approve(values, { ...first, eventRef: 'refs/heads/main' }), 409);
  await refusedBeforeCommit(await f.approve([values[0]], first), 409);
  const edited = (await value(await f.approve([values[0]], { id: input.id, expectedVersion: '1', commitId: commit }))).operation;
  assert.equal(edited.acceptedVersion, '2');
  assert.deepEqual((await f.list()).bindings.map(b => [b.commitId, b.values.length]), [[commit, 1]]);
  // A rotated value leaves the approval pointing at the old version until an administrator approves again.
  await value(await f.save('DEPLOY_TOKEN', 'rotated-fixture-secret', { id: values[0].id, expectedVersion: '1' }));
  await refusedBeforeCommit(await f.approve([values[0]], { id: input.id, expectedVersion: '2' }), 409);
  // The approver's authority is read when the approval is shown: losing administration, even briefly, ends it.
  f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=2; UPDATE grants SET role='write' WHERE user_id=1; UPDATE grants SET role='admin' WHERE user_id=1");
  assert.equal((await f.list()).bindings[0].approvalState, 'authority_unavailable');
  const removal = { id: input.id, expectedVersion: '2', expectedBrokerRevision: (await f.list()).brokerRevision, operationId: nonce() };
  assert.equal((await value(await f.human('DeleteRepositoryExecutionBinding', removal))).operation.action, 'delete_binding');
  assert.equal((await value(await f.human('DeleteRepositoryExecutionBinding', removal))).operation.replayed, true);
  await refusedBeforeCommit(await f.human('DeleteRepositoryExecutionBinding', { ...removal, operationId: nonce(), expectedVersion: '3', expectedBrokerRevision: (await f.list()).brokerRevision }), 409);
  assert.deepEqual((await f.list()).bindings.map(b => [b.deleted, b.version]), [[true, '3']]);
  const current = (await f.list()).values.filter(v => !v.deleted);
  for (let i = 1; i < 20; i++) await value(await f.approve(current));
  await refusedBeforeCommit(await f.approve(current), 400);
  assert.equal((await f.list()).bindings.length, 20);
});

test('repository values stay unavailable without a dedicated key or an approved Actions workflow profile', async t => {
  const f = await executionValueFixture(t), key = f.env.EXECUTION_VALUE_KEY;
  const capability = async () => { const all = (await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.filter(c => c.id === 'settings.repository-secrets'); assert.equal(all.length, 1); return all[0]; };
  // The reason the settings page shows for being closed is the sentence the service refuses with.
  const refusal = async () => { const response = await f.human('ListRepositoryExecutionValues'), shown = await capability(); assert.equal(response.status, 412); const { message } = await response.json();
    assert.deepEqual([shown.state, shown.reason], ['CAPABILITY_STATE_DISABLED', message]); return message; };
  delete f.env.EXECUTION_VALUE_KEY;
  assert.equal(await refusal(), 'Configure a dedicated Secrets Store encryption key for repository values.');
  Object.assign(f.env, { EXECUTION_VALUE_KEY: key, TEST_WORKFLOW_FORMAT: 'gitlab', TEST_WORKFLOW_PATH: '.gitlab-ci.yml' });
  assert.equal(await refusal(), 'Repository values need an operator-approved Actions workflow profile; this installation runs an approved GitLab CI workflow.');
  Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'actions-act', TEST_WORKFLOW_PATH: f.path });
  assert.equal(await refusal(), 'Repository values need an operator-approved Actions workflow profile; this installation runs pinned Actions jobs on customer runners.');
  delete f.env.TEST_WORKFLOW_FORMAT; delete f.env.TEST_WORKFLOW_PATH; f.env.TEST_MODULE = 'test_calc';
  assert.equal(await refusal(), 'Repository values need an operator-approved Actions workflow profile; this installation runs an approved Python test module.');
  // A key alone does not make a module-only installation offer values.
  await refusedBeforeCommit(await f.human('SaveRepositoryExecutionValue', { id: nonce(), expectedVersion: '0', expectedBrokerRevision: '0', operationId: nonce(), name: 'DEPLOY_TOKEN', kind: 1, value: 'fixture-secret-value' }), 412);
  assert.equal((await f.human('NotAMethod')).status, 501);
});

async function releaseFixture(t) {
  const { releaseExecutionValues } = await import('./src/execution-values.mjs');
  const f = await executionValueFixture(t), secret = 'fixture-secret-not-a-real-credential';
  f.env.EVIDENCE_DAILY_LIMIT = '20';
  await value(await f.save('DEPLOY_TOKEN', secret)); await value(await f.save('REGION', 'eu-central', { kind: 2 }));
  const values = (await f.list()).values, binding = { id: nonce() };
  await value(await f.approve(values, binding));
  // The hosted task asks through the workspace; here the same function runs with the same authorization callback.
  const release = id => releaseExecutionValues(f.env, id, job => advanceEvidence(f.env, job, 'authorize-test', f.env.workflow));
  const start = async () => { const job = (await value(await f.evidence({ ...f.input, advice: false, runTests: true, idempotencyKey: nonce() }))).job; assert.equal((await f.advance(job.id, 'tests')).state, 'RUNNING'); return job; };
  const snapshot = id => JSON.parse(f.sql.prepare('SELECT snapshot FROM evidence_jobs WHERE id=?').get(id).snapshot);
  const finish = async (id, output) => { Object.assign(f.execution.tasks.get(id), { state: 'PASSED', cleanup: 'destroyed', exitCode: 0, stdout: '', stderr: '', finishedAt: Date.now(), ...output });
    await f.advance(id, 'tests'); await f.advance(id, 'advice'); await f.advance(id, 'store'); return value(await f.read(id, 'report', readerToken)); };
  // What a new job at the pull request head is admitted with; the job is stopped again so the two-container bound never interferes.
  const admitted = async () => { const job = await start(), approved = snapshot(job.id).execution.values; await value(await f.read(job.id, 'cancel')); return approved; };
  return { ...f, secret, values, binding, release, start, snapshot, finish, admitted, releases: () => f.sql.prepare('SELECT * FROM execution_value_releases').all() };
}

test('an approved exact commit is released once to the hosted job and plaintext reaches no store or report', async t => {
  const f = await releaseFixture(t), job = await f.start(), admitted = f.snapshot(job.id).execution.values, task = f.execution.tasks.get(job.id);
  assert.deepEqual(admitted, { bindingId: f.binding.id, bindingVersion: 1, refs: f.values.map(v => ({ id: v.id, version: 1 })).sort((a, b) => a.id < b.id ? -1 : 1) });
  // The task is admitted with the same identities, bound into its hash, and nothing else.
  assert.deepEqual(task.values, admitted); assert.equal(JSON.stringify(task).includes(f.secret), false);
  assert.equal(f.stored().includes(f.secret), false); assert.deepEqual(f.releases(), []);
  const released = await f.release(job.id);
  assert.deepEqual(released, { state: 'RELEASED', environment: { DEPLOY_TOKEN: f.secret, REGION: 'eu-central' }, secrets: [f.secret] });
  assert.deepEqual(f.releases().map(r => [r.job_id, r.binding_id, r.binding_version]), [[job.id, f.binding.id, 1]]);
  // A second request for the same job gets nothing.
  assert.deepEqual(await f.release(job.id), { state: 'REFUSED' });
  assert.equal(f.stored().includes(f.secret), false);
  // Even a task that reported unmasked output cannot make it durable: the save masks again.
  const half = f.secret.slice(0, 12), stars = '*'.repeat(f.secret.length);
  const result = await f.finish(job.id, { stdout: 'token is ' + f.secret + '\nfirst half ' + half, stderr: f.secret.slice(12) + ' printed by a later step\nregion eu-central\n' });
  assert.equal(result.report.tests.stdout, 'token is ' + stars + '\nfirst half ' + '*'.repeat(12));
  assert.equal(result.report.tests.stderr, '*'.repeat(f.secret.length - 12) + ' printed by a later step\nregion eu-central\n');
  assert.equal(result.report.execution.values, undefined); assert.equal(JSON.stringify(result).includes(f.binding.id), false);
  assert.ok(result.report.limitations.includes('Repository values were released to this administrator-approved exact commit. Exact secret text is masked in the stored output; transformed values are not detected.'));
  for (const [where, text] of [['D1', f.stored()], ['R2', JSON.stringify([...f.objects])], ['report', JSON.stringify(result)], ['status', await (await f.read(job.id)).text()]]) {
    assert.equal(text.includes(f.secret), false, where); assert.equal(text.includes(half), false, where);
  }
  // A finished job cannot be used to ask again.
  assert.deepEqual(await f.release(job.id), { state: 'REFUSED' });
  const capability = (await value(await f.call('', {}, readerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.filter(c => c.id === 'settings.repository-secrets');
  assert.deepEqual(capability.map(c => c.state), ['CAPABILITY_STATE_READY']); assert.match(capability[0].reason, /^Encrypted repository secrets and plain variables, released as environment variables only to an administrator-approved exact commit/);
});

test('a job at an unapproved commit, branch or workflow runs without values and its report says so', async t => {
  const f = await releaseFixture(t), without = 'This job ran without repository values: no current administrator approval matches this exact commit, workflow and head branch.';
  const edit = async fields => value(await f.approve(f.values, { id: f.binding.id, expectedVersion: (await f.list()).bindings[0].version, ...fields }));
  await edit({ commitId: commit });
  const other = await f.start();
  assert.equal(f.snapshot(other.id).execution.values, undefined); assert.equal(f.execution.tasks.get(other.id).values, undefined);
  assert.deepEqual(await f.release(other.id), { state: 'NONE' });
  // The job's output is stored as it was: nothing was released, so nothing is masked.
  const report = (await f.finish(other.id, { stdout: 'echo ' + f.secret })).report;
  assert.ok(report.limitations.includes(without)); assert.equal(report.tests.stdout, 'echo ' + f.secret);
  await edit({ eventRef: 'refs/heads/other' });
  assert.equal(await f.admitted(), undefined);
  await edit({});
  assert.equal((await f.admitted()).bindingId, f.binding.id);
  // The same commit with another workflow file at the approved path is a different source.
  f.state.source = f.state.source.replace('./check.sh', './check.sh && env');
  assert.equal(await f.admitted(), undefined);
  f.state.source = f.state.source.replace(' && env', '');
  assert.equal((await f.admitted()).bindingId, f.binding.id);
  // Two approvals for one source are ambiguous, an expired one is not an approval, and neither is one whose approver lost administration.
  await value(await f.approve([f.values[0]]));
  assert.equal(await f.admitted(), undefined);
  f.sql.prepare('UPDATE execution_bindings SET deleted=1 WHERE id<>?').run(f.binding.id);
  assert.equal((await f.admitted()).bindingId, f.binding.id);
  f.sql.prepare("UPDATE execution_bindings SET expires_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal(await f.admitted(), undefined);
  f.sql.prepare('UPDATE execution_bindings SET expires_at=?').run(new Date(Date.now() + 600000).toISOString());
  assert.equal((await f.admitted()).bindingId, f.binding.id);
  f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=2; UPDATE grants SET role='write' WHERE user_id=1");
  assert.equal(await f.admitted(), undefined);
  assert.deepEqual(f.releases(), []);
  // A repository with no approvals says nothing about values.
  f.sql.exec('UPDATE execution_bindings SET deleted=1');
  const quiet = await f.start();
  assert.equal((await f.finish(quiet.id, {})).report.limitations.some(line => line.includes('repository values')), false);
});

test('a stale approval, changed value, expiry, revoked approver or lost job authority releases nothing', async t => {
  const f = await releaseFixture(t), job = await f.start(), refused = async why => { assert.deepEqual(await f.release(job.id), { state: 'REFUSED' }, why); assert.deepEqual(f.releases(), [], why); };
  assert.ok(f.snapshot(job.id).execution.values);
  const tamper = async (why, change, restore) => { f.sql.exec(change); await refused(why); f.sql.exec(restore); };
  const expiry = f.sql.prepare('SELECT expires_at FROM execution_bindings').get().expires_at, source = f.sql.prepare('SELECT source_sha256 FROM execution_bindings').get().source_sha256;
  await tamper('expired approval', "UPDATE execution_bindings SET expires_at='2000-01-01T00:00:00.000Z'", `UPDATE execution_bindings SET expires_at='${expiry}'`);
  await tamper('newer approval version', 'UPDATE execution_bindings SET version=version+1', 'UPDATE execution_bindings SET version=version-1');
  await tamper('removed approval', 'UPDATE execution_bindings SET deleted=1', 'UPDATE execution_bindings SET deleted=0');
  await tamper('approval moved to another commit', `UPDATE execution_bindings SET commit_id='${commit}'`, `UPDATE execution_bindings SET commit_id='${'b'.repeat(40)}'`);
  await tamper('approval of another origin', "UPDATE execution_bindings SET event='push'", "UPDATE execution_bindings SET event='pull_request'");
  await tamper('approval moved to another branch', "UPDATE execution_bindings SET event_ref='refs/heads/main'", "UPDATE execution_bindings SET event_ref='refs/heads/feature'");
  await tamper('approval of another compiled source', `UPDATE execution_bindings SET source_sha256='${'0'.repeat(64)}'`, `UPDATE execution_bindings SET source_sha256='${source}'`);
  await tamper('rotated value', "UPDATE execution_values SET version=version+1 WHERE name='DEPLOY_TOKEN'", "UPDATE execution_values SET version=version-1 WHERE name='DEPLOY_TOKEN'");
  await tamper('removed value', "UPDATE execution_values SET deleted=1 WHERE name='REGION'", "UPDATE execution_values SET deleted=0 WHERE name='REGION'");
  await tamper('job no longer running its tests', "UPDATE evidence_jobs SET test_state='REQUESTED'", "UPDATE evidence_jobs SET test_state='RUNNING'");
  await tamper('agent job', "UPDATE evidence_jobs SET agent_state='RUNNING'", "UPDATE evidence_jobs SET agent_state='NONE'");
  await tamper('approver identity changed', 'UPDATE native_identity_versions SET version=version+1 WHERE user_id=1', 'UPDATE native_identity_versions SET version=version-1 WHERE user_id=1');
  await tamper('approval names another approver', 'UPDATE execution_bindings SET sponsor_id=2', 'UPDATE execution_bindings SET sponsor_id=1');
  const key = f.env.EXECUTION_VALUE_KEY; delete f.env.EXECUTION_VALUE_KEY; await refused('key removed'); f.env.EXECUTION_VALUE_KEY = key;
  // The job's own authorization is asked first and its answer is final.
  const { releaseExecutionValues } = await import('./src/execution-values.mjs');
  assert.deepEqual(await releaseExecutionValues(f.env, job.id, async () => ({ state: 'REFUSED' })), { state: 'REFUSED' }); assert.deepEqual(f.releases(), []);
  // Everything restored: the same job is released, which shows each refusal above came from its one change.
  assert.equal((await f.release(job.id)).state, 'RELEASED');
  assert.equal(f.releases().length, 1);
  // The approver loses administration while a second job waits; the job's own actor is still a writer.
  f.sql.exec("DELETE FROM execution_value_releases; UPDATE evidence_jobs SET state='REFUSED'");
  const waiting = await f.start();
  f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=2; UPDATE grants SET role='write' WHERE user_id=1");
  assert.equal((await f.advance(waiting.id, 'authorize-test')).state, 'AUTHORIZED');
  assert.deepEqual(await f.release(waiting.id), { state: 'REFUSED' });
  f.sql.exec("UPDATE grants SET role='admin' WHERE user_id=1");
  assert.deepEqual(await f.release(waiting.id), { state: 'REFUSED' });
  // The pull request head moves: the job's authorization itself ends.
  f.setRefs([['refs/heads/main', commit], ['refs/heads/feature', 'c'.repeat(40)]]);
  assert.deepEqual(await f.release(waiting.id), { state: 'REFUSED' });
  assert.deepEqual(f.releases(), []);
});

test('a key that cannot open the released versions delivers nothing and stored output is withheld', async t => {
  const f = await releaseFixture(t), job = await f.start(), key = f.env.EXECUTION_VALUE_KEY;
  f.env.EXECUTION_VALUE_KEY = { get: async () => Buffer.alloc(32, 4).toString('base64') };
  await assert.rejects(f.release(job.id), /^Error: Repository value unavailable$/);
  // The release was recorded, so the job cannot ask again once the key is back, and nothing it prints is stored unchecked.
  assert.equal(f.releases().length, 1);
  const report = (await f.finish(job.id, { stdout: 'unchecked ' + f.secret, stderr: 'also ' + f.secret })).report;
  assert.deepEqual([report.tests.state, report.tests.stdout, report.tests.stderr], ['PASSED', '', 'Output withheld: it could not be checked for repository secrets.\n']);
  f.env.EXECUTION_VALUE_KEY = key;
  assert.deepEqual(await f.release(job.id), { state: 'REFUSED' });
  assert.equal(f.stored().includes(f.secret), false); assert.equal(JSON.stringify([...f.objects]).includes(f.secret), false);
});

test('rotating a value or changing an approval refuses queued jobs admitted under it and stops their containers', async t => {
  const f = await releaseFixture(t), first = await f.start(), state = id => f.sql.prepare('SELECT state FROM evidence_jobs WHERE id=?').get(id).state;
  assert.equal((await f.release(first.id)).state, 'RELEASED');
  const token = f.values.find(v => v.name === 'DEPLOY_TOKEN');
  await value(await f.save('DEPLOY_TOKEN', 'rotated-fixture-secret', { id: token.id, expectedVersion: '1' }));
  assert.equal(state(first.id), 'REFUSED'); assert.equal(f.execution.tasks.get(first.id).state, 'CANCELLED');
  assert.equal((await f.advance(first.id, 'authorize-test')).state, 'REFUSED');
  // The approval still names the old version, so the next job runs without values until an administrator approves again.
  const unapproved = await f.start();
  assert.equal(f.snapshot(unapproved.id).execution.values, undefined);
  const current = (await f.list()).values;
  await value(await f.approve(current, { id: f.binding.id, expectedVersion: '1' }));
  // A job that never had values is not touched by an approval change.
  assert.equal(state(unapproved.id), 'QUEUED'); assert.equal(f.execution.tasks.get(unapproved.id).state, 'RUNNING');
  await f.read(unapproved.id, 'cancel');
  const second = await f.start();
  assert.equal(f.snapshot(second.id).execution.values.bindingVersion, 2);
  await value(await f.human('DeleteRepositoryExecutionBinding', { id: f.binding.id, expectedVersion: '2', expectedBrokerRevision: (await f.list()).brokerRevision, operationId: nonce() }));
  assert.equal(state(second.id), 'REFUSED'); assert.equal(f.execution.tasks.get(second.id).state, 'CANCELLED');
  assert.deepEqual(await f.release(second.id), { state: 'REFUSED' });
  // A refused change fences nothing.
  await value(await f.approve(current, { id: f.binding.id, expectedVersion: '3' }));
  const third = await f.start();
  await refusedBeforeCommit(await f.approve(current, { id: f.binding.id, expectedVersion: '9' }), 409);
  assert.equal(state(third.id), 'QUEUED');
  const region = current.find(v => v.name === 'REGION');
  await value(await f.human('DeleteRepositoryExecutionValue', { id: region.id, expectedVersion: region.version, expectedBrokerRevision: (await f.list()).brokerRevision, operationId: nonce() }));
  assert.equal(state(third.id), 'REFUSED');
  assert.equal(f.stored().includes('rotated-fixture-secret'), false);
});

test('agent jobs and customer-runner jobs receive no values', async t => {
  const { releaseExecutionValues } = await import('./src/execution-values.mjs');
  const f = await releaseFixture(t), authorized = async () => ({ state: 'AUTHORIZED' });
  const hosted = await f.start(), approved = f.snapshot(hosted.id).execution.values;
  // An agent job has no test execution at all; even one forged to carry an approval is refused before the release is recorded.
  const forge = (id, change) => { const snapshot = f.snapshot(id); change(snapshot); f.sql.prepare('UPDATE evidence_jobs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), id); };
  forge(hosted.id, snapshot => { snapshot.agent = { commitId: 'b'.repeat(40), allowedPath: 'calc.py' }; });
  assert.deepEqual(await releaseExecutionValues(f.env, hosted.id, authorized), { state: 'REFUSED' });
  forge(hosted.id, snapshot => { delete snapshot.agent; snapshot.execution.runner = { poolId: nonce(), poolVersion: 1, placementVersion: 1, imageId: 'sha256:' + 'a'.repeat(64) }; });
  assert.deepEqual(await releaseExecutionValues(f.env, hosted.id, authorized), { state: 'REFUSED' });
  for (const contract of ['golf.native.pr-test.v1', 'golf.native.actions-act.v1', 'golf.native.actions-act-build.v1']) {
    forge(hosted.id, snapshot => { delete snapshot.execution.runner; snapshot.execution.contract = contract; });
    assert.deepEqual(await releaseExecutionValues(f.env, hosted.id, authorized), { state: 'REFUSED' }, contract);
  }
  forge(hosted.id, snapshot => { snapshot.execution.contract = 'golf.native.workflow-shell.v1'; snapshot.execution.workflow.plan.format = 'gitlab'; });
  assert.deepEqual(await releaseExecutionValues(f.env, hosted.id, authorized), { state: 'REFUSED' });
  assert.deepEqual(f.releases(), []);
  await assert.rejects(releaseExecutionValues(f.env, 'not-a-job', authorized), /Invalid value release/);
  await f.read(hosted.id, 'cancel');
  // The same approved commit placed on a customer runner is admitted without values and says why.
  const pool = nonce();
  f.env.TEST_IMAGE_ID = 'sha256:' + 'a'.repeat(64);
  f.sql.prepare("INSERT INTO native_runner_pools(id,name,version,state,trust_class,max_parallel,image_id,created_at) VALUES(?,'pool',1,'ACTIVE','UNTRUSTED',1,?,'2026-01-01T00:00:00.000Z')").run(pool, f.env.TEST_IMAGE_ID);
  f.sql.prepare("INSERT INTO native_runner_placements(repository_id,pool_id,pool_version,version,updated_at) VALUES(1,?,1,1,'2026-01-01T00:00:00.000Z')").run(pool);
  const placed = (await value(await f.evidence({ ...f.input, advice: false, runTests: true, idempotencyKey: nonce() }))).job, execution = f.snapshot(placed.id).execution;
  assert.ok(execution.runner); assert.equal(execution.values, undefined);
  assert.deepEqual(await f.release(placed.id), { state: 'NONE' });
  const { executionValueNote } = await import('./src/execution-values.mjs');
  const db = f.env.DB, note = snapshot => executionValueNote(db, { id: placed.id, repository_id: 1 }, snapshot);
  assert.deepEqual(await note(f.snapshot(placed.id)), ['This job ran without repository values: customer-runner jobs do not receive them.']);
  assert.deepEqual(await note({ execution: { ...execution, values: approved } }), ['Repository values were approved for this commit at admission but were not released to the job.']);
  assert.deepEqual(await note({ agent: {} }), []);
  // Neither the agent task nor the customer-runner protocol has a path to the release.
  for (const file of ['./src/agent-worker.mjs', './src/agents.mjs', './src/native-runners.mjs', './src/gitlab-runner.mjs', '../agents/src/worker.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.equal(/testValues|releaseExecutionValues|execution-values/.test(source), false, file);
  }
});

test('with the agent module beside the approved Actions workflow, values reach the workflow run and never the agent job', async t => {
  const { releaseExecutionValues } = await import('./src/execution-values.mjs');
  const f = await releaseFixture(t), agents = allocateAgents(f);
  // The combined profile: the hosted workflow runs pull requests, the module only tests agent proposals.
  Object.assign(f.env, { TEST_WORKFLOW_FORMAT: 'actions', TEST_WORKFLOW_PATH: f.path });
  const config = await value(await f.call('', {}, ownerToken, '/native/config'));
  assert.deepEqual([config.testModule, config.testWorkflowPath, config.agents], ['test_calc', f.path, true]);
  const capability = (await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.find(c => c.id === 'settings.repository-secrets');
  assert.equal(capability.state, 'CAPABILITY_STATE_READY');
  const run = await f.start(), execution = f.snapshot(run.id).execution;
  assert.equal(execution.contract, 'golf.native.workflow-shell.v1'); assert.equal(execution.module, undefined); assert.equal(execution.values.bindingId, f.binding.id);
  assert.deepEqual(await f.release(run.id), { state: 'RELEASED', environment: { DEPLOY_TOKEN: f.secret, REGION: 'eu-central' }, secrets: [f.secret] });
  // An agent job at the same approved commit runs the module and has no test execution to release to.
  const agent = (await value(await f.evidence({ ...f.input, advice: false, agent: { prompt: 'Improve the approved source file.' }, idempotencyKey: nonce() }))).job, snapshot = f.snapshot(agent.id);
  assert.equal(snapshot.agent.module, 'test_calc'); assert.equal(snapshot.execution, undefined);
  await f.advance(agent.id, 'agents'); await f.advance(agent.id, 'agents');
  const task = agents.tasks.get(agent.id);
  assert.equal(task.module, 'test_calc'); assert.equal(task.values, undefined); assert.equal(JSON.stringify(task).includes(f.secret), false);
  assert.deepEqual(await f.release(agent.id), { state: 'REFUSED' });
  // Even with its own authorization granted, an agent job is refused before a release is recorded.
  assert.deepEqual(await releaseExecutionValues(f.env, agent.id, async () => ({ state: 'AUTHORIZED' })), { state: 'REFUSED' });
  assert.deepEqual(f.releases().map(r => r.job_id), [run.id]);
  assert.equal(f.stored().includes(f.secret), false);
  // Without the workflow the same installation is module-only again, and the page closes with the module wording.
  delete f.env.TEST_WORKFLOW_FORMAT; delete f.env.TEST_WORKFLOW_PATH;
  const closed = (await value(await f.call('', {}, ownerToken, '/rpc/golf.v1.CapabilityService/ListCapabilities'))).capabilities.find(c => c.id === 'settings.repository-secrets');
  assert.deepEqual([closed.state, closed.reason], ['CAPABILITY_STATE_DISABLED', 'Repository values need an operator-approved Actions workflow profile; this installation runs an approved Python test module.']);
});

test('only the four upload procedures accept a 300 KiB JSON body; every other request keeps the 96 KiB bound', async t => {
  const f = await fixture(t); await f.create();
  const uploads = ['RepositoryReleaseManagementService/SubmitRepositoryReleaseOperation', 'DiscussionAttachmentUploadService/SubmitDiscussionAttachmentUpload', 'RepositoryFileMutationService/SubmitRepositoryFileMutation', 'RepositoryFileBatchService/SubmitRepositoryFileBatch'];
  const body = size => ({ repository: { owner: 'alice', name: 'project' }, repositoryId: '1', padding: 'x'.repeat(size) });
  for (const procedure of uploads) {
    const path = '/rpc/golf.v1.' + procedure;
    assert.equal(bodyLimit(path), 400 * 1024);
    // Past the bound the request reaches ordinary dispatch, whatever that procedure then answers.
    const accepted = await f.call('', body(300 * 1024), ownerToken, path);
    assert.notEqual(accepted.status, 429); assert.notEqual((await accepted.json()).code, 'resource_exhausted');
    const refused = await f.call('', body(400 * 1024), ownerToken, path);
    assert.equal(refused.status, 429); assert.equal((await refused.json()).code, 'resource_exhausted');
  }
  for (const path of ['/rpc/golf.v1.RepositoryService/CreateIssue', '/rpc/golf.v1.RepositoryService/SubmitRepositoryReleaseOperation', '/rpc/golf.v1.RepositoryReleaseManagementService/GetRepositoryReleaseOperation',
    '/rpc/golf.v1.DiscussionAttachmentService/DownloadDiscussionAttachment', '/rpc/golf.v1.RepositoryFileMutationService/GetRepositoryFileMutationAccess', '/native/repository-grant', '/native/rpc/golf.v1.RepositoryFileBatchService/SubmitRepositoryFileBatch']) {
    assert.equal(bodyLimit(path), 96 * 1024);
    const refused = await f.call('', body(300 * 1024), ownerToken, path);
    assert.equal(refused.status, 429, path); assert.equal((await refused.json()).code, 'resource_exhausted');
  }
  assert.equal((await f.call('GetRepository', body(90 * 1024))).status, 200);
});

test('a renamed workspace row keeps serving while the Worker still carries the earlier name', async t => {
  const f = await fixture(t); await f.create();
  f.sql.exec("UPDATE workspaces SET slug='renamed'");
  assert.equal((await f.call('GetRepository', { repository: { owner: 'alice', name: 'project' } })).status, 200);
});
