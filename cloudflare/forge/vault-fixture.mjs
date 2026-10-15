// Shared by the credential vault and engine tests (docs/CREDENTIAL_VAULT.md, docs/ENGINES.md): node:sqlite as D1 over the real schema, an
// installation key in a Secrets Store stand-in, and a Workers AI binding whose gateway records every outbound provider request.
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handle, advanceAi } from './src/core.mjs';
import { aiKinds, runAiWorkflow } from './src/ai-workflow.mjs';
import { withInstallationPolicy } from './src/installation.mjs';
import { invalid } from './src/common.mjs';

export const origin = 'https://golf.example.com', glm = '@cf/zai-org/glm-5.3', flash = '@cf/zai-org/glm-5.3-flash';
export const deployList = { agents: { default: flash, allowed: [flash, glm] }, 'review-drafts': { default: glm, allowed: [glm, flash] }, 'release-notes': { default: glm, allowed: [glm, flash] } };
export const installationKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 7)).toString('base64');

// A stub AI kind on the review-drafts use: the engine path is under test, not a feature. It reads nothing from Git.
export const probe = { feature: 'ai-review-drafts', use: 'review-drafts', roles: ['admin', 'write'],
  target(value) { if (Object.keys(value || {}).join() !== 'number' || !Number.isInteger(value.number)) invalid('Use one number.'); return { number: value.number }; },
  async prepare({ target }) { return { text: `Pull request ${target.number}` }; },
  async infer({ input, run }) {
    const answer = await run({ messages: [{ role: 'system', content: 'Summarize as JSON.' }, { role: 'user', content: input.text }],
      response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } },
      reasoning_effort: 'low', max_completion_tokens: 300 });
    const choice = answer?.choices?.[0];
    return { summary: choice ? choice.message.content : answer.response };
  } };

export async function vaultFixture(t, { gatewayAnswer, key = installationKey } = {}) {
  aiKinds.probe = probe; t.after(() => { delete aiKinds.probe; });
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO users(id,login,email,can_create,active) VALUES(1,'alice','alice@example.invalid',1,1),(2,'bob','bob@example.invalid',1,1),(3,'carol','carol@example.invalid',1,1),(4,'dave','dave@example.invalid',1,0);
    INSERT INTO operations_admins(user_id) VALUES(1); INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','ai-space');
    INSERT INTO native_owners(id,slug,kind,creator_id) VALUES(10,'acme','ORGANIZATION',1),(11,'other','ORGANIZATION',3);
    INSERT INTO native_owner_members VALUES(10,1,'owner'),(10,2,'member'),(11,3,'owner');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-1',1,'k1','h1','ACTIVE','2026-10-14T00:00:00Z'),
      (2,'tool','','repo-2',1,'k2','h2','ACTIVE','2026-10-14T00:00:00Z'),(3,'elsewhere','','repo-3',3,'k3','h3','ACTIVE','2026-10-14T00:00:00Z');
    INSERT INTO repository_owners VALUES(2,10),(3,11);
    INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write'),(1,3,'read'),(2,1,'admin'),(2,2,'write'),(3,3,'admin')`);
  const statement = query => { const s = sql.prepare(query); let args = [];
    return { query, bind(...values) { args = values; return this; }, async first() { return s.get(...args) || null; }, async all() { return { results: s.all(...args) }; }, async run() { return { meta: { changes: s.run(...args).changes } }; } }; };
  const DB = { withSession() { return this; }, prepare: statement, async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push({ results: [], ...(await s.run()) }); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return out; } };
  const gateway = [], workersAi = [], logs = [];
  const answer = gatewayAnswer || (request => request.provider === 'anthropic'
    ? { content: [{ type: 'text', text: '{"summary":"from claude"}' }], stop_reason: 'end_turn', usage: { input_tokens: 21, output_tokens: 8 } }
    : { choices: [{ message: { role: 'assistant', content: '{"summary":"from gpt"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27, prompt_tokens_details: { cached_tokens: 0 } } });
  const env = { DB, PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'ai-space', ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'golf-gateway', AI_WORKFLOW_NAME: 'golf-ai', AI_MODELS: JSON.stringify(deployList),
    EVIDENCE_BUCKET: {}, EVIDENCE_QUEUE: {}, EVIDENCE_QUEUE_NAME: 'evidence', EVIDENCE_WORKFLOW_NAME: 'evidence', EVIDENCE_DAILY_LIMIT: '5',
    EXECUTION_VALUE_KEY: key === null ? undefined : { async get() { return key; } },
    AI: { async run(model, input, options) { workersAi.push({ model, input, options }); return { choices: [{ message: { content: '{"summary":"from workers ai"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }; },
      gateway(id) { return { async run(request) { gateway.push({ id, request: JSON.parse(JSON.stringify(request)) }); const value = await answer(request); return value instanceof Response ? value : Response.json(value); } }; } },
    AiWorkflow: { async create() {}, async get() { return { status: async () => ({}) }; } }, ARTIFACTS: { async get() { throw Error('No Git here'); } } };
  const call = async (path, body, { who = 'alice', headers = {} } = {}) => {
    const response = await handle(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': who + '@example.invalid',
      'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000)), Origin: origin, ...headers }, body: JSON.stringify(body) }), env);
    const text = await response.text();
    return { status: response.status, value: JSON.parse(text), text };
  };
  const vault = (body, who) => call('/native/credentials', body, { who });
  const engines = (body, who) => call('/native/engines', body, { who });
  const audit = () => sql.prepare('SELECT * FROM installation_audit ORDER BY id').all();
  const project = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1' }, tool = { repository: { owner: 'acme', name: 'tool' }, repositoryId: '2' };
  // The AI run lifecycle with the stub kind: admitted on the HTTP route, then prepare, infer and settle as the Workflow runs them.
  const runProbe = async (who = 'alice', repo = project) => {
    const admitted = await call('/native/ai', { ...repo, action: 'create', kind: 'probe', target: { number: 1 }, idempotencyKey: crypto.randomUUID() }, { who });
    if (admitted.status !== 200) return { admitted };
    const id = admitted.value.run.id;
    const result = await runAiWorkflow({ instanceId: id, payload: { runId: id } }, { async do(name, options, action) { return JSON.parse(JSON.stringify(await action())); } }, env,
      { ai: (runId, phase, value) => advanceAi(env, runId, phase, value) }, withInstallationPolicy);
    return { admitted, result, run: sql.prepare('SELECT * FROM ai_runs WHERE id=?').get(id), engine: sql.prepare('SELECT * FROM ai_run_engines WHERE run_id=?').get(id) };
  };
  return { sql, env, DB, gateway, workersAi, logs, call, vault, engines, audit, project, tool, runProbe };
}
