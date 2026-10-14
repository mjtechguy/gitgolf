import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handle, advanceAi, concurrentRead } from './src/core.mjs';
import { invalid } from './src/common.mjs';
import { aiKinds, runAiWorkflow } from './src/ai-workflow.mjs';
import { aiModel, aiModelStillAllowed, withAgentModel, validModels } from './src/ai-models.mjs';
import { gatewayAnalytics } from './src/ai-usage.mjs';
import { withInstallationPolicy } from './src/installation.mjs';
import { policyIdentity } from '../agents/src/policy.mjs';

const origin = 'https://golf.example.com', flash = '@cf/zai-org/glm-5.3-flash', glm = '@cf/zai-org/glm-5.3', glm52 = '@cf/zai-org/glm-5.2';
const qwen = '@cf/qwen/qwen3-embedding-0.6b', bge = '@cf/baai/bge-m3';
const deployList = { agents: { default: flash, allowed: [flash, glm] }, 'review-drafts': { default: glm, allowed: [glm, flash, glm52] }, 'release-notes': { default: glm, allowed: [glm, flash] },
  search: { default: qwen, allowed: [qwen, bge], dimensions: { [qwen]: 1024, [bge]: 1024 } } };
// The account catalog as env.AI.models({ task }) answers it: names are model ids, properties are id/value strings.
const catalogue = () => [
  { id: 'u1', name: flash, description: 'Fast GLM 5.3.', task: { name: 'Text Generation' }, properties: [{ property_id: 'function_calling', value: 'true' }, { property_id: 'context_window', value: '131072' }, { property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.06, currency: 'USD' }] }] },
  { id: 'u2', name: glm, description: 'GLM 5.3.', task: { name: 'Text Generation' }, properties: [{ property_id: 'function_calling', value: 'true' }] },
  { id: 'u3', name: glm52, description: 'GLM 5.2.', task: { name: 'Text Generation' }, properties: [] },
  { id: 'u4', name: '@cf/meta/llama-4', description: 'Not on the deploy list.', task: { name: 'Text Generation' }, properties: [] },
  { id: 'u5', name: qwen, description: 'Qwen3 embedding.', task: { name: 'Text Embeddings' }, properties: [] },
  { id: 'u6', name: bge, description: 'BGE M3.', task: { name: 'Text Embeddings' }, properties: [] },
];

async function fixture(t, { list = catalogue } = {}) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO users(id,login,email,can_create) VALUES(1,'alice','alice@example.invalid',1),(2,'bob','bob@example.invalid',1);
    INSERT INTO operations_admins(user_id) VALUES(1); INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','ai-space');
    INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-1',1,'key','hash','ACTIVE','2026-10-14T00:00:00Z');
    INSERT INTO grants VALUES(1,1,'admin'),(1,2,'write')`);
  const statement = query => { const s = sql.prepare(query); let args = [];
    return { query, bind(...values) { args = values; return this; }, async first() { return s.get(...args) || null; }, async all() { return { results: s.all(...args) }; }, async run() { return { meta: { changes: s.run(...args).changes } }; } }; };
  const DB = { withSession() { return this; }, prepare: statement, async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push({ results: [], ...(await s.run()) }); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return out; } };
  const reads = [], calls = [];
  const env = { DB, PUBLIC_ORIGIN: origin, WORKSPACE_SLUG: 'alice', ACCOUNT_ID: 'c'.repeat(32), ARTIFACTS_NAMESPACE: 'ai-space', ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    EVIDENCE_ALLOW_AI: 'true', EVIDENCE_GATEWAY: 'golf-gateway', AI_WORKFLOW_NAME: 'golf-ai', AI_MODELS: JSON.stringify(deployList), SEARCH_DIMENSIONS: '1024',
    EVIDENCE_BUCKET: {}, EVIDENCE_QUEUE: {}, EVIDENCE_QUEUE_NAME: 'evidence', EVIDENCE_WORKFLOW_NAME: 'evidence', EVIDENCE_DAILY_LIMIT: '5',
    AI: { async models({ task }) { reads.push(task); return list(); }, async run(model) { calls.push(model); return { response: 'ok', usage: { input_tokens: 3, output_tokens: 2 } }; } },
    AiWorkflow: { async create() {}, async get() { return { status: async () => ({}) }; } }, ARTIFACTS: { async get() { throw Error('No Git here'); } } };
  const call = async (path, body, { who = 'alice', headers = {} } = {}) => {
    const response = await handle(new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Golf-Native-Access-Email': who + '@example.invalid',
      'X-Golf-Native-Access-Issued-At': String(Math.floor(Date.now() / 1000)), ...headers }, body: JSON.stringify(body) }), env);
    return { status: response.status, value: await response.json() };
  };
  const read = async () => (await call('/native/ai-models/read', { action: 'installation' })).value;
  const update = async (use, value, extra = {}) => {
    const current = (await read()).uses.find(item => item.use === use);
    return call('/native/ai-models', { action: 'update', use, value, expectedVersion: current.version, operationId: crypto.randomUUID(), ...extra });
  };
  const repo = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1' };
  return { sql, env, reads, calls, call, read, update, repo };
}

test('the deploy list is the ceiling and every use reads its model through aiModel', async t => {
  const f = await fixture(t), db = f.env.DB;
  assert.deepEqual(await aiModel(db, f.env, 'agents', 1), { use: 'agents', model: flash, source: 'deploy', note: '' });
  assert.equal((await aiModel(db, f.env, 'advice', 1)).model, '@cf/cloudflare/clef');
  assert.equal((await aiModel(db, f.env, 'triage', 1)).source, 'fixed');
  assert.equal((await aiModel(db, { ...f.env, AI_MODELS: undefined }, 'review-drafts')).model, glm);
  // An invalid deploy list allows nothing; it never widens to the built-in defaults.
  await assert.rejects(aiModel(db, { ...f.env, AI_MODELS: '{"agents":{"default":"x","allowed":["x"]}}' }, 'agents'), /lists no Workers AI model/);
  assert.equal(validModels({ agents: { default: flash, allowed: [glm] } }), null);
  assert.equal(validModels({ advice: { default: flash, allowed: [flash] } }), null);
  assert.equal(validModels({ agents: { default: flash, allowed: [flash], dimensions: { [flash]: 1024 } } }), null);
  await assert.rejects(aiModel(db, f.env, 'unknown'), /Unknown AI use/);
});

test('administrators read the catalog-backed choices; others cannot', async t => {
  const f = await fixture(t);
  assert.equal(concurrentRead(new Request(origin + '/native/ai-models/read', { method: 'POST' })), true);
  assert.equal(concurrentRead(new Request(origin + '/native/ai-models', { method: 'POST' })), false);
  assert.equal(concurrentRead(new Request(origin + '/native/ai-usage/read', { method: 'POST' })), true);
  assert.equal((await f.call('/native/ai-models/read', { action: 'installation' }, { who: 'bob' })).status, 403);
  let view = await f.read();
  assert.equal(view.catalog.stale, true); assert.equal(view.editing.enabled, true);
  const agents = view.uses.find(item => item.use === 'agents');
  assert.deepEqual(agents.options.map(o => o.state), ['unread', 'unread']);
  assert.equal(view.uses.find(item => item.use === 'advice').fixed, true);
  // Opening the page refreshes the six-hour catalog; a second refresh within a minute is skipped.
  view = (await f.call('/native/ai-models', { action: 'refresh-catalog' })).value;
  assert.deepEqual(f.reads.sort(), ['Text Embeddings', 'Text Generation']);
  await f.call('/native/ai-models', { action: 'refresh-catalog', force: true }); assert.equal(f.reads.length, 2);
  assert.equal(view.catalog.stale, false);
  const options = use => Object.fromEntries(view.uses.find(item => item.use === use).options.map(o => [o.model, o]));
  assert.equal(options('agents')[flash].state, 'available'); assert.equal(options('agents')[flash].price, '$0.06 per M input tokens'); assert.equal(options('agents')[flash].contextWindow, '131072');
  assert.equal(options('review-drafts')[glm52].state, 'available');
  assert.equal(view.uses.find(item => item.use === 'review-drafts').otherCatalogModels, 1);
  assert.equal(options('search')[bge].dimensions, 1024);
  // The search_state table arrives with the semantic search migration: no index yet, so nothing to re-index.
  assert.deepEqual(view.uses.find(item => item.use === 'search').reindex, { known: true, repositories: 0, chunks: 0, calls: 0 });
});

test('a model without a reported capability is unverified and cannot be allowed; widening needs typed confirmation', async t => {
  const f = await fixture(t, { list: () => catalogue().map(m => m.name === glm ? { ...m, properties: [] } : m) });
  await f.call('/native/ai-models', { action: 'refresh-catalog' });
  const agents = (await f.read()).uses.find(item => item.use === 'agents');
  assert.equal(agents.options.find(o => o.model === glm).state, 'unverified');
  // The deploy value allows both; narrowing to one needs no confirmation.
  const narrowed = await f.update('agents', { default: flash, allowed: [flash], repositoryOverride: false });
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.value)); assert.equal(narrowed.value.widening, false);
  // Allowing glm again widens, and it is unverified now: refused before any write.
  const refused = await f.update('agents', { default: flash, allowed: [flash, glm], repositoryOverride: false }, { confirmation: 'ai.model.agents' });
  assert.equal(refused.status, 412); assert.match(refused.value.message, /capability unverified/);
  const wider = await f.update('agents', { default: flash, allowed: [flash], repositoryOverride: true });
  assert.equal(wider.status, 412); assert.match(wider.value.message, /Type ai\.model\.agents/);
  const old = await f.update('agents', { default: flash, allowed: [flash], repositoryOverride: true }, { confirmation: 'ai.model.agents', headers: {} });
  assert.equal(old.status, 200);
  const audit = f.sql.prepare("SELECT * FROM installation_audit WHERE subject='ai.model.agents' ORDER BY id").all();
  assert.deepEqual(audit.map(row => [row.action, row.widening]), [['ai_model.update', 0], ['ai_model.update', 1]]);
  assert.deepEqual(JSON.parse(audit[1].after), { default: flash, allowed: [flash], repositoryOverride: true });
});

test('updates are revision-fenced, idempotent, inside the deploy list and locked by policy_editing:false', async t => {
  const f = await fixture(t);
  await f.call('/native/ai-models', { action: 'refresh-catalog' });
  const value = { default: glm52, allowed: [glm52, glm], repositoryOverride: false }, operationId = crypto.randomUUID();
  const first = await f.call('/native/ai-models', { action: 'update', use: 'review-drafts', value, expectedVersion: '0', operationId });
  assert.equal(first.status, 200, JSON.stringify(first.value)); assert.equal(first.value.version, '1');
  const replay = await f.call('/native/ai-models', { action: 'update', use: 'review-drafts', value, expectedVersion: '0', operationId });
  assert.deepEqual(replay.value, first.value);
  assert.equal((await f.call('/native/ai-models', { action: 'update', use: 'review-drafts', value: { ...value, default: glm }, expectedVersion: '0', operationId: crypto.randomUUID() })).status, 412);
  assert.equal((await aiModel(f.env.DB, f.env, 'review-drafts', 1)).model, glm52);
  assert.match((await f.update('review-drafts', { default: '@cf/meta/llama-4', allowed: ['@cf/meta/llama-4'], repositoryOverride: false }, { confirmation: 'ai.model.review-drafts' })).value.message, /not on this installation’s deploy list/);
  assert.equal((await f.update('review-drafts', { default: flash, allowed: [glm], repositoryOverride: false })).status, 400);
  assert.equal((await f.update('advice', { default: glm, allowed: [glm], repositoryOverride: false })).status, 412);
  assert.equal((await f.call('/native/ai-models', { action: 'update', use: 'review-drafts', value, expectedVersion: '1', operationId: crypto.randomUUID() }, { who: 'bob' })).status, 403);
  f.env.INSTALLATION_POLICY_EDITING = 'false';
  assert.match((await f.update('review-drafts', { ...value, allowed: [glm52] })).value.message, /policy_editing: false/);
  // Locked: deploy values apply, saved choices are not read.
  assert.equal((await aiModel(f.env.DB, f.env, 'review-drafts', 1)).model, glm);
  assert.equal((await f.read()).editing.enabled, false);
});

test('repositories choose only where allowed, and fall back when an administrator narrows the list', async t => {
  const f = await fixture(t);
  await f.call('/native/ai-models', { action: 'refresh-catalog' });
  const choose = (model, version = '0', who = 'alice') => f.call('/native/ai-models', { action: 'repository-update', ...f.repo, use: 'review-drafts', model, expectedVersion: version }, { who });
  assert.match((await choose(flash)).value.message, /does not let repositories choose/);
  await f.update('review-drafts', { default: glm, allowed: [glm, flash, glm52], repositoryOverride: true }, { confirmation: 'ai.model.review-drafts' });
  assert.equal((await choose(flash, '0', 'bob')).status, 403);
  assert.equal((await choose('@cf/meta/llama-4')).status, 412);
  const chosen = await choose(flash);
  assert.equal(chosen.status, 200, JSON.stringify(chosen.value));
  assert.deepEqual(await aiModel(f.env.DB, f.env, 'review-drafts', 1), { use: 'review-drafts', model: flash, source: 'repository', note: '' });
  assert.equal((await choose(glm52, '0')).status, 412);
  const view = (await f.call('/native/ai-models/read', { action: 'repository', ...f.repo }, { who: 'bob' })).value;
  const drafts = view.uses.find(item => item.use === 'review-drafts');
  assert.equal(view.canEdit, false); assert.equal(drafts.model, flash); assert.equal(drafts.choice, flash); assert.equal(drafts.version, '1');
  // The change's own batch wrote the success row; the dispatch hook added only the refusal of bob, who is not an administrator.
  assert.deepEqual(f.sql.prepare("SELECT scope,scope_id,subject,after,json_extract(client,'$.outcome') AS outcome FROM installation_audit WHERE action='repository_ai_model.update' ORDER BY id").all().map(row => ({ ...row })),
    [{ scope: 'repository', scope_id: '1', subject: 'ai.model.review-drafts', after: null, outcome: 'denied' }, { scope: 'repository', scope_id: '1', subject: 'ai.model.review-drafts', after: JSON.stringify(flash), outcome: null }]);
  // Narrowing keeps the repository row but it no longer applies.
  await f.update('review-drafts', { default: glm, allowed: [glm], repositoryOverride: true });
  const fallback = await aiModel(f.env.DB, f.env, 'review-drafts', 1);
  assert.equal(fallback.model, glm); assert.match(fallback.note, /no longer allowed/);
  assert.equal((await f.read()).uses.find(item => item.use === 'review-drafts').repositoriesOverriding, 1);
});

test('retired models fall back to the deploy default and refuse runs admitted with them', async t => {
  let list = catalogue();
  const f = await fixture(t, { list: () => list });
  await f.call('/native/ai-models', { action: 'refresh-catalog' });
  await f.update('review-drafts', { default: glm52, allowed: [glm52, glm], repositoryOverride: false });
  assert.equal(await aiModelStillAllowed(f.env.DB, f.env, 'review-drafts', glm52), true);
  list = catalogue().filter(m => m.name !== glm52);
  f.sql.exec("UPDATE ai_model_catalog_reads SET attempted_at='2026-01-01'");
  await f.call('/native/ai-models', { action: 'refresh-catalog', force: true });
  const view = (await f.read()).uses.find(item => item.use === 'review-drafts');
  assert.equal(view.options.find(o => o.model === glm52).state, 'retired'); assert.match(view.notes.join(' '), /retired/);
  assert.deepEqual(await aiModel(f.env.DB, f.env, 'review-drafts', 1), { use: 'review-drafts', model: glm, source: 'deploy', note: `${glm52} was retired, so the deploy default applies.` });
  assert.equal(await aiModelStillAllowed(f.env.DB, f.env, 'review-drafts', glm52), false);
  // An empty catalog answer is not evidence that everything was removed.
  list = [];
  f.sql.exec("UPDATE ai_model_catalog_reads SET attempted_at='2026-01-01'");
  await f.call('/native/ai-models', { action: 'refresh-catalog', force: true });
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM ai_model_catalog WHERE retired_at IS NULL").get().n, 5);
  assert.match(f.sql.prepare("SELECT reason FROM ai_model_catalog_reads WHERE task='Text Generation'").get().reason, /listed no Text Generation models/);
});

test('an AI run records the effective model and is refused, unbilled, when the model stops being allowed before inference', async t => {
  const f = await fixture(t), db = f.env.DB;
  aiKinds.draftProbe = { feature: 'advice', use: 'review-drafts', roles: ['admin'], target(value) { if (!Number.isInteger(value?.number)) invalid('Use a number.'); return { number: value.number }; },
    async prepare() { return { text: 'x' }; }, async infer({ run }) { return { text: (await run({ prompt: 'x' })).response }; } };
  t.after(() => { delete aiKinds.draftProbe; });
  await f.call('/native/ai-models', { action: 'refresh-catalog' });
  await f.update('review-drafts', { default: glm52, allowed: [glm52, glm], repositoryOverride: false });
  const create = async () => (await f.call('/native/ai', { action: 'create', kind: 'draftProbe', target: { number: 1 }, idempotencyKey: crypto.randomUUID(), ...f.repo })).value.run;
  const workflow = id => runAiWorkflow({ instanceId: id, payload: { runId: id } }, { async do(name, options, action) { return JSON.parse(JSON.stringify(await action())); } }, f.env,
    { ai: (runId, phase, result) => advanceAi(f.env, runId, phase, result) }, withInstallationPolicy);
  const first = await create();
  assert.equal(first.model, glm52);
  assert.deepEqual(await workflow(first.id), { id: first.id, state: 'SUCCEEDED' });
  assert.deepEqual(f.calls, [glm52]);
  const second = await create();
  await f.update('review-drafts', { default: glm, allowed: [glm], repositoryOverride: false });
  assert.deepEqual(await workflow(second.id), { id: second.id, state: 'REFUSED' });
  assert.match(f.sql.prepare('SELECT refusal FROM ai_runs WHERE id=?').get(second.id).refusal, /no longer allowed.*nothing was billed/);
  assert.deepEqual(f.calls, [glm52]);
  assert.equal(f.sql.prepare('SELECT model FROM ai_runs WHERE id=?').get(first.id).model, glm52);
  assert.equal((await create()).model, glm);
});

test('the agent model is bound into the agent policy identity', async t => {
  const f = await fixture(t), deploy = 'd'.repeat(64);
  const env = { ...f.env, AGENT_POLICY_SHA256: deploy };
  const before = await withAgentModel(f.env.DB, env, 1);
  assert.equal(before.AGENT_MODEL, flash); assert.equal(before.AGENT_POLICY_SHA256, await policyIdentity(deploy, flash)); assert.equal(before.AGENT_DEPLOY_POLICY_SHA256, deploy);
  assert.equal(await withAgentModel(f.env.DB, before, 1), before);
  await f.call('/native/ai-models', { action: 'refresh-catalog' });
  await f.update('agents', { default: glm, allowed: [glm, flash], repositoryOverride: false });
  const after = await withAgentModel(f.env.DB, env, 1);
  assert.equal(after.AGENT_MODEL, glm); assert.notEqual(after.AGENT_POLICY_SHA256, before.AGENT_POLICY_SHA256);
  // Nothing usable: agent execution is off rather than running an unapproved model.
  const off = await withAgentModel(f.env.DB, { ...env, AI_MODELS: '[]' }, 1);
  assert.equal(off.AGENT_EXECUTION_ENABLED, 'false');
  assert.equal(await withAgentModel(f.env.DB, f.env, 1), f.env);
});

test('AI usage reads Golf’s ledger by feature, model and day; gateway analytics are degraded until a live read succeeds', async t => {
  const f = await fixture(t), today = new Date().toISOString().slice(0, 10), now = new Date().toISOString();
  const run = (kind, model, state, usage) => f.sql.prepare(`INSERT INTO ai_runs(id,kind,repository_id,user_id,operation_key,input_hash,target,model,state,usage,infer_started_at,created_at,updated_at,expires_at)
    VALUES(?,?,1,1,?,'h','{}',?,?,?,?,?,?,?)`).run(crypto.randomUUID(), kind, crypto.randomUUID(), model, state, usage, state === 'REFUSED' ? null : now, now, now, now);
  run('review-draft', glm, 'SUCCEEDED', JSON.stringify({ input_tokens: 100, output_tokens: 20 }));
  run('review-draft', glm, 'UNKNOWN', null);
  run('review-draft', glm, 'REFUSED', null);
  run('release-notes', flash, 'SUCCEEDED', JSON.stringify({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 11 }));
  const job = (advice, agent) => f.sql.prepare(`INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,state,snapshot,advice_state,advice,agent_state,agent_result,created_at,updated_at,expires_at)
    VALUES(?,1,1,?,'h','SUCCEEDED','{}',?,?,?,?,?,?,?)`).run(crypto.randomUUID(), crypto.randomUUID(), advice ? 'SUCCEEDED' : 'NONE', advice, agent ? 'succeeded' : 'NONE', agent, now, now, now);
  job(JSON.stringify({ model: '@cf/cloudflare/clef', usage: { input_tokens: 40, output_tokens: 1 } }), null);
  job(null, JSON.stringify({ model: glm, tokens: 900 }));
  assert.equal((await f.call('/native/ai-usage/read', { action: 'read' }, { who: 'bob' })).status, 403);
  assert.equal((await f.call('/native/ai-usage/read', { action: 'read', days: 31 })).status, 400);
  const usage = (await f.call('/native/ai-usage/read', { action: 'read' })).value;
  assert.deepEqual(usage.limit, { daily: 100, todayRuns: 4, source: 'default' });
  assert.deepEqual(usage.unreadable, []);
  const row = (feature, model) => usage.rows.find(r => r.feature === feature && r.model === model);
  assert.deepEqual(row('review-draft', glm), { day: today, feature: 'review-draft', source: 'runs', model: glm, runs: 3, succeeded: 1, failed: 1, refused: 1, pending: 0, inputTokens: 100, outputTokens: 20, tokens: 120, reported: 1 });
  assert.equal(row('release-notes', flash).tokens, 11);
  assert.equal(row('advice', '@cf/cloudflare/clef').tokens, 41);
  assert.equal(row('agents', glm).tokens, 900);
  // No token bound: unavailable with a reason, never a zero.
  assert.equal(usage.gateway.state, 'unavailable'); assert.equal(usage.gateway.requests, undefined); assert.equal(usage.caps, null);
  f.env.AI_GATEWAY_LIMITS = JSON.stringify({ requestsPerMinute: 60, spendCentsPerDay: 500 });
  f.env.OPERATIONS_ANALYTICS_TOKEN = { async get() { return 't'.repeat(40); } };
  const answer = (value, status = 200) => async (url, init) => { assert.equal(JSON.parse(init.body).variables.gateway, 'golf-gateway'); return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); };
  const degraded = await gatewayAnalytics(f.env, answer({ data: null, errors: [{ message: 'unknown field aiGatewayRequestsAdaptiveGroups' }] }), 3);
  assert.equal(degraded.state, 'degraded'); assert.match(degraded.reason, /refused the query: unknown field/); assert.equal(degraded.cost, undefined);
  assert.match((await gatewayAnalytics(f.env, answer({ data: { viewer: { accounts: [{ aiGatewayRequestsAdaptiveGroups: [] }] } } }), 3)).reason, /no rows although Golf recorded 3 calls/);
  const sum = { cost: 0.0123, uncachedTokensIn: 120, uncachedTokensOut: 30, cachedTokensIn: 0, cachedTokensOut: 0, erroredRequests: 1 };
  const observed = await gatewayAnalytics(f.env, answer({ data: { viewer: { accounts: [{ aiGatewayRequestsAdaptiveGroups: [{ count: 4, sum, dimensions: { model: glm } }] }] } } }), 3);
  assert.equal(observed.state, 'observed'); assert.equal(observed.requests, 4); assert.equal(observed.cost, 0.0123); assert.equal(observed.tokensIn, 120);
  assert.deepEqual(observed.models, [{ model: glm, requests: 4, cost: 0.0123, errors: 1 }]);
  assert.equal((await gatewayAnalytics(f.env, async () => { throw Object.assign(Error('x'), { name: 'TimeoutError' }); })).reason, 'The analytics API did not answer within 5 seconds.');
  assert.deepEqual((await f.call('/native/ai-usage/read', { action: 'read' })).value.caps, { requestsPerMinute: 60, spendCentsPerDay: 500 });
});
