// Automations (docs/AUTOMATIONS.md) on real workerd, D1, the workspace Durable Object and the local Workflows engine: an issue created
// through the API queues an issue-triage run, the workspace starts it after the response, the AI run settles in the Workflow and the
// workspace applies the label and the comment; Run now on a custom automation; a due schedule swept by the scheduled handler.
// Run: node cloudflare/forge/automations-runtime-check.mjs "$(command -v cf)". The models are local stubs inside the Workflow: no inference
// is claimed. Only the Artifacts binding and the provider's ref advertisement are fixtures.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
import { digest } from './src/common.mjs';
import { packetLine } from './src/git.mjs';
const cli = dirname(dirname(realpathSync(process.argv[2])));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13') throw Error('Qualify native CLI');
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(resolve(cli, 'node_modules/miniflare/dist/src/index.js')).href);

const head = 'a'.repeat(40), artifactName = 'repo-' + '1'.repeat(32);
const built = await esbuild.build({ stdin: { resolveDir: resolve('cloudflare/forge'), sourcefile: 'automations-runtime-fixture.mjs', contents: `
export { default, RepositoryReads } from './src/worker.mjs';
import { Workspace as ProductionWorkspace, AiWorkflow as Production } from './src/worker.mjs';
import { remote } from './src/git.mjs';
export class Workspace extends ProductionWorkspace {
  constructor(ctx, env) {
    super(ctx, { ...env, ARTIFACTS: { async get(name) { return { async info() { return { name, remote: remote(env, name) }; },
      async createToken() { return { plaintext: 'local-only-token' }; }, async revokeToken() { return true; }, [Symbol.dispose]() {},
      async readCommit(hash) { return hash === '${head}' ? { hash, treeHash: '${'f'.repeat(40)}', parents: [], message: 'Initial\\n' } : null; } }; } } });
  }
}
// Clef picks the first label with 0.9; the text model answers custom automations with Markdown that must be neutralized.
export class AiWorkflow extends Production {
  run(event, step) {
    this.env = { ...this.env, AI: { async run(model, input, options) {
      if (options?.gateway?.id !== 'local-gateway') throw Error('Not through the gateway');
      if (model === '@cf/cloudflare/clef') {
        const keys = Object.keys(input.questions.label.criteria), probabilities = Object.fromEntries(keys.map(key => [key, key === 'l1' ? 0.9 : 0.1 / (keys.length - 1)]));
        return { answers: { label: { type: 'choice', choice: 'l1', probabilities } }, usage: { input_tokens: 120, output_tokens: 2 } };
      }
      if (model === '@cf/zai-org/glm-5.3') return { choices: [{ message: { content: 'Weekly report: 1 open issue. [click](https://evil.example) @team' }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 12 } };
      throw Error('Unexpected model ' + model);
    } } };
    return super.run(event, step);
  }
}` }, bundle: true, write: false, format: 'esm', platform: 'neutral',
  define: { GOLF_NATIVE_ASSETS: 'null', GOLF_NATIVE_RELEASE: '"local"', GOLF_NATIVE_CONFIGURATION: '"local"' }, nodePaths: ['cloudflare/agents/node_modules'],
  conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'] });
const origin = 'https://golf.example.com', token = 'golf_native_' + 'a'.repeat(43);
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 0, modules: [{ type: 'ESModule', path: 'worker.mjs', contents: built.outputFiles[0].text }], compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
  bindings: { PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ARTIFACTS_NAMESPACE: 'local-automations', ACCOUNT_ID: 'a'.repeat(32),
    EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'local-gateway', AI_WORKFLOW_NAME: 'local-ai', AI_DAILY_LIMIT: '20' },
  serviceBindings: { AI: () => new Response('The workspace must not call the model.', { status: 500 }) },
  workflows: { AiWorkflow: { name: 'local-ai', className: 'AiWorkflow' } },
  d1Databases: { DB: 'local-automations' }, durableObjects: { WORKSPACE: { className: 'Workspace', useSQLite: true } }, r2Buckets: ['EVIDENCE_BUCKET'],
  outboundService: async request => {
    const url = new URL(request.url);
    assert.equal(url.origin + url.pathname, `https://${'a'.repeat(32)}.artifacts.cloudflare.net/git/local-automations/${artifactName}.git/info/refs`);
    return new Response(Buffer.concat([packetLine('# service=git-upload-pack\n'), Buffer.from('0000'), packetLine(`${head} refs/heads/main\0report-status\n`), Buffer.from('0000')]),
      { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
  },
}));
try {
  const db = await runtime.getD1Database('DB');
  for (const sql of (await readFile(new URL('./schema.sql', import.meta.url), 'utf8')).replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE\b)/).filter(s => s.trim())) await db.prepare(sql).run();
  for (const statement of [
    "INSERT INTO users(id,login,can_create) VALUES(1,'alice',1)", "INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','local-automations')",
    `INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','${artifactName}',1,'key','hash','ACTIVE','2026-10-14T00:00:00Z')`,
    "INSERT INTO grants VALUES(1,1,'admin')",
    ...['bug', 'docs'].map(name => `INSERT INTO discussion_resources(repository_id,kind,name,payload) VALUES(1,'label','${name}','{"name":"${name}","description":"","color":"d73a4a","exclusive":false,"archived":false,"organizationOwned":false}')`),
  ]) await db.prepare(statement).run();
  await db.prepare('INSERT INTO credentials VALUES(?,?,?,0)').bind(await digest(token), 1, Math.floor(Date.now() / 1000) + 300).run();
  const call = async (path, body) => {
    const response = await runtime.dispatchFetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ repository: { owner: 'alice', name: 'project' }, repositoryId: '1', ...body }) });
    return { status: response.status, value: await response.json() };
  };
  const automations = body => call('/native/automations', { scope: 'repository', ...body });
  const runs = async () => (await call('/native/automations/read', { scope: 'repository', action: 'runs' })).value.runs;
  const finished = async (id, count = 1) => {
    for (let i = 0; i < 400; i++) {
      const listed = (await runs()).filter(run => run.automationId === id);
      if (listed.length >= count && listed.every(run => !['QUEUED', 'RUNNING'].includes(run.state))) return listed;
      await new Promise(next => setTimeout(next, 25));
    }
    throw Error('The automation run did not finish: ' + JSON.stringify(await runs()));
  };
  const capabilities = (await call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).value.capabilities;
  assert.equal(capabilities.find(c => c.id === 'automations')?.state, 'CAPABILITY_STATE_READY');
  assert.equal((await call('/native/diagnostics', {})).value.schema, 46);

  // Issue triage on issue.opened: created off, turned on, then an issue created through the API.
  const made = await automations({ action: 'create', tool: 'issue-triage', output: ['labels', 'comment'] });
  assert.equal(made.status, 200, JSON.stringify(made.value));
  const triage = made.value.automation;
  assert.equal((await automations({ action: 'setEnabled', id: triage.id, expectedVersion: triage.version, enabled: true })).status, 200);
  const issue = await call('/rpc/golf.v1.RepositoryService/CreateIssue', { title: 'Crash on empty config', body: '', idempotencyKey: crypto.randomUUID() });
  assert.equal(issue.status, 200, JSON.stringify(issue.value));
  const [triaged] = await finished(triage.id);
  assert.equal(triaged.state, 'SUCCEEDED', JSON.stringify(triaged));
  assert.deepEqual([triaged.trigger, triaged.target.number, triaged.outputs.labels, triaged.usage], ['issue.opened', issue.value.mutation.number, ['bug'], { inputTokens: 120, outputTokens: 2, reported: true }]);
  const labels = await db.prepare("SELECT r.name FROM discussion_labels l JOIN discussion_resources r ON r.id=l.label_id JOIN discussions d ON d.id=l.discussion_id WHERE d.number=?").bind(issue.value.mutation.number).all();
  assert.deepEqual(labels.results.map(row => row.name), ['bug']);
  const comment = await db.prepare("SELECT c.body FROM discussion_comments c JOIN discussions d ON d.id=c.discussion_id WHERE d.number=?").bind(issue.value.mutation.number).first();
  assert.match(comment.body, /^> Automation \*\*Issue triage\*\*/); assert.match(comment.body, /Applied the label bug\./); assert.match(comment.body, /little detail/);

  // Run now on a custom automation (off): an AI run of kind automation, its report neutralized.
  const custom = (await automations({ action: 'create', tool: 'custom', name: 'Weekly report', output: ['report'], instructions: 'Report the open work.', trigger: { events: [], schedule: { everyMinutes: 60 } } })).value.automation;
  const manual = await automations({ action: 'run', id: custom.id, target: { kind: 'repository' } });
  assert.equal(manual.status, 200, JSON.stringify(manual.value));
  const [reported] = await finished(custom.id);
  assert.equal(reported.state, 'SUCCEEDED', JSON.stringify(reported));
  assert.equal(reported.outputs.report, 'Weekly report: 1 open issue. click @​team');

  // A due schedule: the scheduled handler's maintenance sweeps it and the workspace runs it.
  assert.equal((await automations({ action: 'setEnabled', id: custom.id, expectedVersion: (await call('/native/automations/read', { scope: 'repository', action: 'get', id: custom.id })).value.automation.version, enabled: true })).status, 200);
  await db.prepare('UPDATE automations SET next_run_at=? WHERE id=?').bind(Date.now() - 1000, custom.id).run();
  const scheduled = await (await runtime.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() });
  assert.equal(scheduled.outcome, 'ok');
  const all = await finished(custom.id, 2);
  assert.deepEqual(all.map(run => [run.trigger, run.state]).sort(), [['manual', 'SUCCEEDED'], ['schedule', 'SUCCEEDED']]);
  assert.ok((await db.prepare('SELECT next_run_at FROM automations WHERE id=?').bind(custom.id).first()).next_run_at > Date.now() + 50 * 60_000);
  const audit = await db.prepare("SELECT action FROM installation_audit WHERE action LIKE 'automation.%' ORDER BY id").all();
  assert.deepEqual(audit.results.map(row => row.action), ['automation.create', 'automation.enable', 'automation.create', 'automation.run', 'automation.enable']);
  console.log('Real workerd/D1/DO/Workflows automations: issue.opened queued by the API and started by the workspace after the response, Clef triage applied as a label and a labelled comment after the AI run settled, Run now on a custom automation with a neutralized report, and a due schedule swept by the scheduled handler passed');
} finally { await runtime.dispose(); }
