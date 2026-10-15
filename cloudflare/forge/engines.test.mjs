import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vaultFixture, glm, flash } from './vault-fixture.mjs';
import { aiModel } from './src/ai-models.mjs';
import { resolveEngine, listEngines, runChat, providerRequest, providerAnswer } from './src/engines.mjs';

const anthropicKey = 'sk-ant-api03-Secret-Anthropic-Key-0001', openaiKey = 'sk-proj-Secret-OpenAI-Key-0002';
const everything = sql => JSON.stringify(sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => sql.prepare(`SELECT * FROM "${name}"`).all()));
const alice = { id: 1, login: 'alice' }, bob = { id: 2, login: 'bob' }, carol = { id: 3, login: 'carol' };
const repo = id => ({ id });

// Installation: an Anthropic key shared with everyone and an engine using it; acme: an OpenAI key for its members and an engine.
async function setup(f) {
  const installationKey = await f.vault({ action: 'create', scope: 'installation', kind: 'api-key', provider: 'anthropic', label: 'Installation Anthropic', value: anthropicKey, grants: [{ granteeKind: 'installation' }] });
  assert.equal(installationKey.status, 200, installationKey.text);
  const claude = await f.engines({ action: 'create', scope: 'installation', name: 'Claude Sonnet', kind: 'provider-model', provider: 'anthropic', model: 'claude-sonnet-4-5', credentialId: installationKey.value.credential.id });
  assert.equal(claude.status, 200, claude.text);
  const fast = await f.engines({ action: 'create', scope: 'installation', name: 'GLM flash', kind: 'cloudflare-model', model: flash });
  assert.equal(fast.status, 200, fast.text);
  const acmeKey = await f.vault({ action: 'create', scope: 'organization', organization: 'acme', kind: 'api-key', provider: 'openai', label: 'Acme OpenAI', value: openaiKey, grants: [{ granteeKind: 'organization', grantee: 'acme' }] });
  const gpt = await f.engines({ action: 'create', scope: 'organization', organization: 'acme', name: 'Acme GPT', kind: 'provider-model', provider: 'openai', model: 'gpt-5', credentialId: acmeKey.value.credential.id });
  assert.equal(gpt.status, 200, gpt.text);
  return { claude: claude.value.engine, fast: fast.value.engine, gpt: gpt.value.engine, acmeKey: acmeKey.value.credential, installationKey: installationKey.value.credential };
}
const select = async (f, scope, use, engineId, allowOverride = false, extra = {}, who = 'alice') => {
  const listed = await f.engines({ action: 'list', scope, ...extra }, who);
  const version = listed.value.uses?.find(u => u.use === use)?.selection?.version ?? 0;
  return f.engines({ action: 'select', scope, use, engineId, allowOverride, expectedVersion: version, ...extra }, who);
};

test('without a selection every use resolves to the AI models choice, so existing features keep their model', async t => {
  const f = await vaultFixture(t);
  for (const use of ['review-drafts', 'release-notes', 'triage', 'agents', 'search'].filter(use => use !== 'search')) {
    const resolved = await resolveEngine(f.DB, f.env, { person: alice, repository: repo(1), useCase: use });
    const expected = await aiModel(f.DB, f.env, use, 1);
    assert.equal(resolved.model, expected.model, use); assert.equal(resolved.engine.kind, 'cloudflare-model'); assert.equal(resolved.credential, null);
    assert.equal(resolved.source, use === 'triage' ? 'fixed' : 'default');
  }
  assert.equal((await resolveEngine(f.DB, f.env, { person: alice, repository: repo(1), useCase: 'triage' })).model, '@cf/cloudflare/clef');
  // An AI run admitted with the default records the Workers AI model and no engine row, and calls Workers AI as before.
  const { run, engine } = await f.runProbe();
  assert.equal(run.state, 'SUCCEEDED', run.refusal); assert.equal(run.model, glm); assert.equal(engine, undefined);
  assert.deepEqual(f.workersAi.map(call => call.model), [glm]); assert.deepEqual(f.gateway, []);
  assert.deepEqual(JSON.parse(run.output), { summary: '{"summary":"from workers ai"}' });
  // AI models changes still apply through engines.
  f.sql.prepare("INSERT INTO installation_settings(key,value,version,updated_by,updated_at) VALUES('ai.model.review-drafts',?,1,1,'t')").run(JSON.stringify({ default: flash, allowed: [glm, flash], repositoryOverride: false }));
  assert.equal((await resolveEngine(f.DB, f.env, { person: alice, repository: repo(1), useCase: 'review-drafts' })).model, flash);
  await assert.rejects(resolveEngine(f.DB, f.env, { person: alice, useCase: 'unknown' }), /Unknown engine use/);
});

test('precedence: installation, then organization, then repository, each only where the level above allows it', async t => {
  const f = await vaultFixture(t), e = await setup(f);
  // Installation chooses Claude without letting anyone else choose.
  assert.equal((await select(f, 'installation', 'review-drafts', e.claude.id)).status, 200);
  const org = { organization: 'acme' };
  const refused = await select(f, 'organization', 'review-drafts', e.gpt.id, false, org);
  assert.equal(refused.status, 412); assert.match(refused.value.message, /does not let organizations choose/);
  let resolved = await resolveEngine(f.DB, f.env, { person: bob, repository: repo(2), useCase: 'review-drafts' });
  assert.equal(resolved.source, 'installation'); assert.equal(resolved.engine.id, e.claude.id); assert.equal(resolved.model, 'anthropic/claude-sonnet-4-5');
  assert.equal(resolved.credential.label, 'Installation Anthropic'); assert.equal(JSON.stringify(resolved).includes(anthropicKey), false);
  // Installation lets organizations choose; acme picks its GPT engine and lets repositories choose.
  assert.equal((await select(f, 'installation', 'review-drafts', e.claude.id, true)).status, 200);
  assert.equal((await select(f, 'organization', 'review-drafts', e.gpt.id, true, org, 'bob')).status, 403);
  assert.equal((await select(f, 'organization', 'review-drafts', e.gpt.id, true, org)).status, 200);
  resolved = await resolveEngine(f.DB, f.env, { person: bob, repository: repo(2), useCase: 'review-drafts' });
  assert.equal(resolved.source, 'organization'); assert.equal(resolved.model, 'openai/gpt-5');
  // A personal repository is outside acme: the installation choice applies there.
  assert.equal((await resolveEngine(f.DB, f.env, { person: bob, repository: repo(1), useCase: 'review-drafts' })).source, 'installation');
  // acme's engine cannot be chosen outside acme.
  const project = { repository: { owner: 'alice', name: 'project' }, repositoryId: '1' }, tool = { repository: { owner: 'acme', name: 'tool' }, repositoryId: '2' };
  assert.equal((await select(f, 'repository', 'review-drafts', e.gpt.id, false, project)).status, 400);
  // The repository chooses the built-in flash model; repository administrators only.
  assert.equal((await select(f, 'repository', 'review-drafts', 'workers-ai:' + flash, false, tool, 'bob')).status, 403);
  assert.equal((await select(f, 'repository', 'review-drafts', 'workers-ai:' + flash, false, tool)).status, 200);
  resolved = await resolveEngine(f.DB, f.env, { person: bob, repository: repo(2), useCase: 'review-drafts' });
  assert.equal(resolved.source, 'repository'); assert.equal(resolved.model, flash); assert.equal(resolved.credential, null);
  // The organization withdraws the repository choice: it stops counting at once.
  assert.equal((await select(f, 'organization', 'review-drafts', e.gpt.id, false, org)).status, 200);
  assert.equal((await resolveEngine(f.DB, f.env, { person: bob, repository: repo(2), useCase: 'review-drafts' })).source, 'organization');
  assert.equal((await select(f, 'repository', 'review-drafts', '', false, tool)).status, 412);
  // Uses that are not selectable say why.
  const listed = await f.engines({ action: 'list', scope: 'installation' });
  assert.match(listed.value.uses.find(u => u.use === 'triage').reason, /Clef/);
  assert.equal((await select(f, 'installation', 'triage', e.claude.id)).status, 400);
  // Engines in use cannot be deleted; disabling one falls back to the default with a note.
  assert.equal((await f.engines({ action: 'delete', id: e.claude.id })).status, 412);
  assert.equal((await select(f, 'installation', 'review-drafts', e.claude.id, false)).status, 200);
  const disabled = await f.engines({ action: 'update', id: e.claude.id, expectedVersion: 1, enabled: false });
  assert.equal(disabled.status, 200, disabled.text);
  resolved = await resolveEngine(f.DB, f.env, { person: carol, repository: repo(1), useCase: 'review-drafts' });
  assert.equal(resolved.source, 'default'); assert.equal(resolved.model, glm); assert.match(resolved.note, /disabled/);
  const actions = f.audit().map(entry => entry.action);
  assert.ok(actions.includes('engine.create') && actions.includes('engine.update') && actions.includes('engine_selection.update'));
});

test('provider calls go through the AI Gateway binding in each provider’s shape; the key is only in the outbound headers', async t => {
  const f = await vaultFixture(t), e = await setup(f);
  await select(f, 'installation', 'review-drafts', e.claude.id, true);
  const { run, engine, admitted } = await f.runProbe('alice', f.project);
  assert.equal(admitted.status, 200, admitted.text);
  assert.equal(run.state, 'SUCCEEDED', run.refusal); assert.equal(run.model, 'anthropic/claude-sonnet-4-5');
  assert.deepEqual(JSON.parse(run.output), { summary: '{"summary":"from claude"}' });
  assert.deepEqual(JSON.parse(run.usage), { input_tokens: 21, output_tokens: 8 });
  assert.equal(engine.engine_id, e.claude.id); assert.equal(engine.credential_label, 'Installation Anthropic'); assert.equal(engine.engine_version, 1);
  assert.deepEqual(f.workersAi, []);
  assert.equal(f.gateway.length, 1);
  const [{ id, request }] = f.gateway;
  assert.equal(id, 'golf-gateway'); assert.equal(request.provider, 'anthropic'); assert.equal(request.endpoint, 'v1/messages');
  assert.equal(request.headers['x-api-key'], anthropicKey); assert.equal(request.headers['anthropic-version'], '2023-06-01'); assert.equal(request.headers.authorization, undefined);
  assert.equal(request.query.model, 'claude-sonnet-4-5'); assert.equal(request.query.max_tokens, 300);
  assert.match(request.query.system, /^Summarize as JSON\.\n\nAnswer with only one JSON object/); assert.deepEqual(request.query.messages, [{ role: 'user', content: 'Pull request 1' }]);
  assert.equal(JSON.stringify(request.query).includes(anthropicKey), false);
  // The key appears nowhere else: not in D1 (sealed only), the run, the audit log or the HTTP answer.
  assert.equal(everything(f.sql).includes(anthropicKey), false); assert.equal(admitted.text.includes(anthropicKey), false);
  assert.ok(f.sql.prepare("SELECT last_used_at FROM vault_credentials WHERE label='Installation Anthropic'").get().last_used_at);
  // acme's GPT engine in acme's repository: OpenAI chat completions with a bearer key and the structured output format.
  await select(f, 'organization', 'review-drafts', e.gpt.id, false, { organization: 'acme' });
  const second = await f.runProbe('bob', f.tool);
  assert.equal(second.run.state, 'SUCCEEDED', second.run.refusal); assert.equal(second.run.model, 'openai/gpt-5');
  assert.deepEqual(JSON.parse(second.run.usage), { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 });
  const openai = f.gateway[1].request;
  assert.equal(openai.provider, 'openai'); assert.equal(openai.endpoint, 'chat/completions'); assert.equal(openai.headers.authorization, 'Bearer ' + openaiKey);
  assert.equal(openai.query.max_completion_tokens, 300); assert.equal(openai.query.response_format.json_schema.name, 'probe'); assert.equal(openai.query.reasoning_effort, undefined);
  assert.equal(JSON.stringify(openai.query).includes(openaiKey), false);
  assert.equal(everything(f.sql).includes(openaiKey), false);
});

test('a refused credential refuses the run at admission or before inference, unbilled and audited', async t => {
  const f = await vaultFixture(t), e = await setup(f);
  await select(f, 'installation', 'review-drafts', e.claude.id, true);
  await select(f, 'organization', 'review-drafts', e.gpt.id, true, { organization: 'acme' });
  // Carol is no acme member: acme's key is not shared with her (she has no grant on acme/tool either, so she cannot even ask).
  f.sql.exec("INSERT INTO grants VALUES(2,3,'write')");
  const refused = await f.runProbe('carol', f.tool);
  assert.equal(refused.admitted.status, 412); assert.match(refused.admitted.value.message, /not allowed to use credential Acme OpenAI/);
  assert.ok(f.audit().some(entry => entry.action === 'credential.use_denied' && entry.scope === 'repository' && entry.scope_id === '2'));
  // Revoked after admission: inference never starts and nothing is billed.
  const admitted = await f.call('/native/ai', { ...f.tool, action: 'create', kind: 'probe', target: { number: 2 }, idempotencyKey: crypto.randomUUID() }, { who: 'bob' });
  assert.equal(admitted.status, 200, admitted.text);
  assert.equal((await f.vault({ action: 'revoke', id: e.acmeKey.id })).status, 200);
  const { advanceAi } = await import('./src/core.mjs'), { aiInfer } = await import('./src/ai-workflow.mjs');
  const id = admitted.value.run.id;
  const prepared = await advanceAi(f.env, id, 'prepare');
  assert.equal(prepared.state, 'REFUSED');
  assert.match(f.sql.prepare('SELECT refusal FROM ai_runs WHERE id=?').get(id).refusal, /revoked; nothing was billed\./);
  assert.deepEqual(await aiInfer(f.env, id), { state: 'REFUSED' });
  assert.equal(f.gateway.length, 0);
});

test('the automations interface: listEngines, resolveEngine with an explicit engine and runChat', async t => {
  const f = await vaultFixture(t), e = await setup(f);
  const listed = await listEngines(f.DB, f.env, bob, { repository: repo(2) });
  const byName = Object.fromEntries(listed.map(engine => [engine.name, engine]));
  assert.ok(byName['Workers AI · zai-org/glm-5.3'].builtIn);
  assert.equal(byName['Claude Sonnet'].usable, true); assert.equal(byName['Acme GPT'].usable, true);
  assert.equal(JSON.stringify(listed).includes('credential_id'), false);
  const outside = await listEngines(f.DB, f.env, carol, { repository: repo(1) });
  assert.equal(outside.some(engine => engine.name === 'Acme GPT'), false);
  // A personal engine with Carol's own key: listed for her, usable only by her.
  const key = await f.vault({ action: 'create', scope: 'user', kind: 'api-key', provider: 'openai', label: 'Carol key', value: 'sk-carol-0000-1111-2222' }, 'carol');
  const mine = await f.engines({ action: 'create', scope: 'user', name: 'Carol GPT', kind: 'provider-model', provider: 'openai', model: 'gpt-5-mini', credentialId: key.value.credential.id }, 'carol');
  assert.equal(mine.status, 200, mine.text);
  assert.ok((await listEngines(f.DB, f.env, carol, {})).some(engine => engine.name === 'Carol GPT' && engine.usable));
  const handle = await resolveEngine(f.DB, f.env, { person: carol, useCase: 'automations', engineId: mine.value.engine.id });
  const answer = await runChat(f.env, handle, [{ role: 'user', content: 'Hello' }], { maxTokens: 50 });
  assert.deepEqual(answer, { text: '{"summary":"from gpt"}', usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 }, finishReason: 'stop' });
  assert.equal(f.gateway.at(-1).request.headers.authorization, 'Bearer sk-carol-0000-1111-2222');
  await assert.rejects(resolveEngine(f.DB, f.env, { person: bob, useCase: 'automations', engineId: mine.value.engine.id }), /belongs to another organization|not allowed/);
  // Workers AI through runChat, and handles that runChat refuses.
  const workers = await resolveEngine(f.DB, f.env, { person: bob, useCase: 'automations', engineId: 'workers-ai:' + flash });
  assert.equal((await runChat(f.env, workers, [{ role: 'user', content: 'Hi' }])).text, '{"summary":"from workers ai"}');
  // A reasoning effort reaches Workers AI models (GLM otherwise spends a small budget thinking), never a provider request.
  await runChat(f.env, workers, [{ role: 'user', content: 'Hi' }], { maxTokens: 200, reasoningEffort: 'low' });
  assert.equal(f.workersAi.at(-1).input.reasoning_effort, 'low');
  await runChat(f.env, workers, [{ role: 'user', content: 'Hi' }], { reasoningEffort: 'extreme' });
  assert.equal('reasoning_effort' in f.workersAi.at(-1).input, false);
  await runChat(f.env, handle, [{ role: 'user', content: 'Hello' }], { reasoningEffort: 'low' });
  assert.equal(JSON.stringify(f.gateway.at(-1)).includes('reasoning_effort'), false);
  await assert.rejects(runChat(f.env, { ...workers }, [{ role: 'user', content: 'Hi' }]), /Not a resolved engine handle/);
  const cli = await f.engines({ action: 'create', scope: 'installation', name: 'Codex on hosts', kind: 'coding-cli', tool: 'codex', places: ['agent-host', 'ssh-host'] });
  assert.equal(cli.status, 200, cli.text); assert.deepEqual(cli.value.engine.places, ['agent-host', 'ssh-host']);
  await assert.rejects(resolveEngine(f.DB, f.env, { person: bob, useCase: 'automations', engineId: cli.value.engine.id }), /coding CLI/);
  // Validation: provider engines need a same-scope key of their provider; Workers AI engines stay on the deploy list.
  assert.equal((await f.engines({ action: 'create', scope: 'installation', name: 'Wrong key', kind: 'provider-model', provider: 'openai', model: 'gpt-5', credentialId: e.installationKey.id })).status, 400);
  assert.equal((await f.engines({ action: 'create', scope: 'installation', name: 'Org key', kind: 'provider-model', provider: 'openai', model: 'gpt-5', credentialId: e.acmeKey.id })).status, 400);
  assert.equal((await f.engines({ action: 'create', scope: 'installation', name: 'Llama', kind: 'cloudflare-model', model: '@cf/meta/llama-4' })).status, 400);
  assert.equal((await f.engines({ action: 'create', scope: 'installation', name: 'Bob', kind: 'cloudflare-model', model: flash }, 'bob')).status, 403);
});

test('provider shapes and answers: xAI and Google requests, normalized answers, and errors that never carry the key', async t => {
  const xai = providerRequest('xai', 'grok-4', { messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 10 }, 'xai-key-1');
  assert.deepEqual([xai.provider, xai.endpoint, xai.headers.authorization, xai.query.max_tokens], ['grok', 'v1/chat/completions', 'Bearer xai-key-1', 10]);
  const google = providerRequest('google', 'gemini-2.5-pro', { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } } }, 'g-key');
  assert.equal(google.provider, 'google-ai-studio'); assert.equal(google.endpoint, 'v1beta/models/gemini-2.5-pro:generateContent'); assert.equal(google.headers['x-goog-api-key'], 'g-key');
  assert.deepEqual(google.query.contents.map(c => c.role), ['user', 'model']); assert.equal(google.query.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(providerAnswer('google', { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }),
    { choices: [{ message: { role: 'assistant', content: 'ab' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  assert.equal(providerAnswer('anthropic', { content: [{ type: 'text', text: 'hi' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }).choices[0].finish_reason, 'length');
  // A provider error that echoes the key: the run settles unknown and the key is stored nowhere.
  const f = await vaultFixture(t, { gatewayAnswer: request => new Response(JSON.stringify({ error: `invalid x-api-key ${request.headers['x-api-key']}` }), { status: 401 }) }), e = await setup(f);
  await select(f, 'installation', 'review-drafts', e.claude.id);
  const { run } = await f.runProbe();
  assert.equal(run.state, 'UNKNOWN');
  assert.equal(everything(f.sql).includes(anthropicKey), false);
  const handle = await resolveEngine(f.DB, f.env, { person: alice, useCase: 'review-drafts' });
  await assert.rejects(runChat(f.env, handle, [{ role: 'user', content: 'x' }]), error => { assert.equal(error.message.includes(anthropicKey), false); assert.match(error.message, /Anthropic answered HTTP 401/); return true; });
});

test('capabilities and engine reads respect each scope', async t => {
  const f = await vaultFixture(t);
  const capability = (await f.call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).value.capabilities.find(c => c.id === 'settings.engines');
  assert.equal(capability.state, 'CAPABILITY_STATE_READY');
  assert.equal((await f.engines({ action: 'list', scope: 'installation' }, 'bob')).status, 403);
  assert.equal((await f.engines({ action: 'list', scope: 'organization', organization: 'acme' }, 'carol')).status, 403);
  const member = await f.engines({ action: 'list', scope: 'organization', organization: 'acme' }, 'bob');
  assert.equal(member.status, 200); assert.equal(member.value.canManage, false); assert.equal(member.value.canSelect, false);
  const repository = await f.engines({ action: 'list', scope: 'repository', ...f.tool }, 'bob');
  assert.equal(repository.status, 200); assert.equal(repository.value.canSelect, false);
  assert.equal(repository.value.uses.find(u => u.use === 'review-drafts').effective.model, glm);
  const admin = await f.engines({ action: 'list', scope: 'installation' });
  assert.deepEqual(admin.value.builtIn.map(engine => engine.model).sort(), [flash, glm].sort());
  assert.equal(admin.value.gateway, true);
  const noGateway = await vaultFixture(t);
  delete noGateway.env.AI.gateway;
  assert.match((await noGateway.call('/rpc/golf.v1.CapabilityService/ListCapabilities', {})).value.capabilities.find(c => c.id === 'settings.engines').reason, /Provider models are unavailable/);
});
