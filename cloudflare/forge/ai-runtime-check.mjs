// Workers AI run lifecycle on real workerd, D1, the workspace Durable Object and the local Workflows engine; no provider calls.
// Run: node cloudflare/forge/ai-runtime-check.mjs "$(command -v cf)". The model is a local stub inside the Workflow: no inference is claimed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
import { digest } from './src/common.mjs';
const cli = dirname(dirname(realpathSync(process.argv[2])));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);
// The production Worker with one stub kind registered, and a recording model in place of the AI binding inside the Workflow only.
const built = await esbuild.build({ stdin: { resolveDir: resolve('cloudflare/forge'), sourcefile: 'ai-runtime-fixture.mjs', contents: `
export { default, Workspace, RepositoryReads } from './src/worker.mjs';
import { AiWorkflow as Production } from './src/worker.mjs';
import { aiKinds } from './src/ai-workflow.mjs';
import { untrusted } from './src/ai.mjs';
aiKinds.probe = { feature: 'ai-probe', model: '@cf/local/stub', roles: ['admin', 'write'],
  target: value => ({ number: Number(value?.number) || 1 }),
  prepare: async ({ row, target }) => ({ text: 'Issue ' + target.number + ' in ' + row.name }),
  infer: async ({ input, run }) => (await run({ prompt: untrusted('issue', input.text) })).echo };
export class AiWorkflow extends Production {
  run(event, step) {
    this.env = { ...this.env, AI: { async run(model, input, options) {
      if (input.prompt.includes('Issue 2 ')) throw Error('Local gateway failure');
      return { echo: { model, options, marked: /^<untrusted-[a-f0-9]{24} label="issue">/.test(input.prompt) }, usage: { input_tokens: 3, output_tokens: 1 } };
    } } };
    return super.run(event, step);
  }
}` }, bundle: true, write: false, format: 'esm', platform: 'neutral',
  define: { GOLF_NATIVE_ASSETS: 'null', GOLF_NATIVE_RELEASE: '"local"', GOLF_NATIVE_CONFIGURATION: '"local"' }, nodePaths: ['cloudflare/agents/node_modules'],
  conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'] });
const origin = 'https://golf.example.com', token = 'golf_native_' + 'a'.repeat(43);
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 0, modules: [{ type: 'ESModule', path: 'worker.mjs', contents: built.outputFiles[0].text }], compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ARTIFACTS_NAMESPACE: 'local-ai-proof', ACCOUNT_ID: 'a'.repeat(32),
    EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'local-gateway', AI_WORKFLOW_NAME: 'local-ai', AI_DAILY_LIMIT: '3' },
  // The workspace only checks that an AI binding is allocated; it never calls it.
  serviceBindings: { AI: () => new Response('The workspace must not call the model.', { status: 500 }) },
  workflows: { AiWorkflow: { name: 'local-ai', className: 'AiWorkflow' } },
  d1Databases: { DB: 'local-ai-proof' }, durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true } },
}));
try {
  const db = await runtime.getD1Database('DB');
  for (const sql of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(sql).run();
  await db.prepare("INSERT INTO users(id,login,can_create) VALUES(1,'alice',1)").run();
  await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','local-ai-proof')").run();
  await db.prepare('INSERT INTO credentials VALUES(?,?,?,0)').bind(await digest(token), 1, Math.floor(Date.now() / 1000) + 300).run();
  await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-1',1,'key','hash','ACTIVE','2026-10-14T00:00:00Z')").run();
  await db.prepare("INSERT INTO grants VALUES(1,1,'admin')").run();
  const call = async (path, body) => {
    const response = await runtime.dispatchFetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ...body }) });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await call('/native/diagnostics', {})).value.schema, 32);
  const settled = async id => {
    for (let i = 0; i < 200; i++) {
      const { value } = await call('/native/ai/read', { action: 'status', runId: id });
      if (!['REQUESTED', 'RESERVED'].includes(value.run.state)) return value.run;
      await new Promise(next => setTimeout(next, 25));
    }
    throw Error('AI run did not settle');
  };
  const workflows = (await runtime.getBindings()).AiWorkflow;
  const created = await call('/native/ai', { action: 'create', kind: 'probe', target: { number: 1 }, idempotencyKey: crypto.randomUUID() });
  assert.equal(created.status, 200, JSON.stringify(created.value)); assert.equal(created.value.run.state, 'REQUESTED');
  const run = await settled(created.value.run.id);
  assert.equal(run.state, 'SUCCEEDED', JSON.stringify(run));
  assert.deepEqual(run.output, { model: '@cf/local/stub', options: { gateway: { id: 'local-gateway', skipCache: true, collectLog: false } }, marked: true });
  assert.deepEqual(run.usage, { input_tokens: 3, output_tokens: 1 });
  const instance = await (await workflows.get(run.id)).status();
  assert.equal(instance.status, 'complete'); assert.deepEqual(instance.output, { id: run.id, state: 'SUCCEEDED' });
  // The repository text stays in D1: the Workflow's recorded outputs carry states only.
  assert.ok(!JSON.stringify(instance).includes('Issue 1 in project'));
  const failed = await call('/native/ai', { action: 'create', kind: 'probe', target: { number: 2 }, idempotencyKey: crypto.randomUUID() });
  const unknown = await settled(failed.value.run.id);
  assert.equal(unknown.state, 'UNKNOWN'); assert.equal(unknown.output, undefined);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM ai_runs WHERE infer_started_at IS NOT NULL').first()).n, 2);
  await call('/native/ai', { action: 'create', kind: 'probe', target: { number: 3 }, idempotencyKey: crypto.randomUUID() });
  const limited = await call('/native/ai', { action: 'create', kind: 'probe', target: { number: 4 }, idempotencyKey: crypto.randomUUID() });
  assert.equal(limited.status, 429);
  console.log('Real workerd/D1/DO/Workflows AI runs: admission, prepare in the workspace, one gateway-shaped call in the Workflow, settle, unknown outcome and the daily limit passed');
} finally { await runtime.dispose(); }
