// Shared by the label-suggestion and release-notes tests: node:sqlite as D1, the real /native/ai routes and workspace steps,
// a fake Artifacts repository with advertised refs, and a recording model in place of the AI binding.
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { digest, handle, advanceAi } from './src/core.mjs';
import { packetLine } from './src/git.mjs';
import { runAiWorkflow } from './src/ai-workflow.mjs';
import { withInstallationPolicy } from './src/installation.mjs';

export const tokens = { alice: 'golf_native_' + 'a'.repeat(43), bob: 'golf_native_' + 'b'.repeat(43), carol: 'golf_native_' + 'c'.repeat(43) };
export const artifactName = 'repo-' + '1'.repeat(32);

// git: { refs: Map(ref → hash), commits: Map(hash → commit) }; answer(model, input) is the model.
export async function aiKindFixture(t, { answer = async () => ({}), git = { refs: new Map(), commits: new Map() } } = {}) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login) VALUES(1,'alice'),(2,'bob'),(3,'carol'); INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','ai-space')");
  sql.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','',?,1,'key','hash','ACTIVE','2026-10-14T00:00:00Z')").run(artifactName);
  sql.exec("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read'),(1,3,'write')");
  for (const [login, token] of Object.entries(tokens)) sql.prepare('INSERT INTO credentials SELECT ?,id,?,0 FROM users WHERE login=?').run(await digest(token), Math.floor(Date.now() / 1000) + 300, login);
  const db = { withSession() { return this; }, prepare(query) { let values = []; const statement = sql.prepare(query); return {
    bind(...args) { values = args; return this; }, async first() { return statement.get(...values) || null; },
    async all() { return { results: statement.all(...values) }; }, async run() { return { meta: { changes: statement.run(...values).changes } }; } }; } };
  const calls = [], reads = { log: 0, readCommit: 0, refs: 0 };
  const env = { DB: db, ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'ai-space', WORKSPACE_SLUG: 'alice', PUBLIC_ORIGIN: 'https://golf.example.com',
    EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'golf-gateway', AI_WORKFLOW_NAME: 'golf-ai',
    EVIDENCE_BUCKET: {}, EVIDENCE_QUEUE: {}, EVIDENCE_QUEUE_NAME: 'evidence', EVIDENCE_WORKFLOW_NAME: 'evidence', EVIDENCE_DAILY_LIMIT: '5',
    AI: { async run(model, input, options) { calls.push({ model, input, options }); return answer(model, input); } },
    AiWorkflow: { async create() {}, async get() { return { status: async () => ({ status: 'queued' }) }; } },
    ARTIFACTS: { async get(name) { return {
      async info() { return { name, remote: `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/ai-space/${name}.git` }; },
      async createToken() { return { plaintext: 'art_v1_read' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
      async readCommit(hash) { reads.readCommit++; return git.commits.get(hash) || null; },
      // Like the provider: newest first along the history, bounded.
      async log({ ref, limit }) { reads.log++; const out = []; for (let at = git.commits.get(ref); at && out.length < limit; at = git.commits.get(at.parents[0])) out.push(at); return out; },
    }; } } };
  // gitRequest uses the global fetch: answer the ref advertisement from the fixture's refs.
  const fetched = globalThis.fetch;
  globalThis.fetch = async () => { reads.refs++; return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'),
    ...[...git.refs].map(([ref, hash], index) => packetLine(`${hash} ${ref}${index === 0 ? '\0report-status' : ''}\n`)), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } }); };
  t.after(() => { globalThis.fetch = fetched; });
  const call = async (path, body, who = 'alice') => {
    const response = await handle(new Request(env.PUBLIC_ORIGIN + path, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ...body }) }), env);
    return { status: response.status, value: await response.json() };
  };
  const create = (kind, target, who = 'alice') => call('/native/ai', { action: 'create', kind, target, idempotencyKey: crypto.randomUUID() }, who);
  const status = (id, who = 'alice') => call('/native/ai/read', { action: 'status', runId: id }, who);
  // The fake engine passes step outputs through JSON, as Workflows persists them; hooks run before a named step.
  const workflow = (id, hooks = {}) => runAiWorkflow({ instanceId: id, payload: { runId: id } }, { async do(name, options, action) {
    await hooks[name]?.(); return JSON.parse(JSON.stringify(await action())); } }, env, { ai: (runId, phase, result) => advanceAi(env, runId, phase, result) }, withInstallationPolicy);
  // Admit, run the whole workflow and read the settled run back.
  const complete = async (kind, target, hooks) => {
    const admitted = await create(kind, target);
    if (admitted.status !== 200) throw Error(JSON.stringify(admitted.value));
    await workflow(admitted.value.run.id, hooks);
    return (await status(admitted.value.run.id)).value.run;
  };
  const run = id => sql.prepare('SELECT * FROM ai_runs WHERE id=?').get(id);
  return { sql, env, calls, reads, git, call, create, status, workflow, complete, run };
}
