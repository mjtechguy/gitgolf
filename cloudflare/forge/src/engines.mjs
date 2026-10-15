// Engines (docs/ENGINES.md, agents plan phase 2a): what does the thinking, chosen per AI use case at installation, organization and
// repository level. Engine selection replaces per-use-case model selection: with no selection, a use case runs the Workers AI model
// chosen in AI models (ai-models.mjs), exactly as before. Kinds:
//   cloudflare-model — a Workers AI model inside the deploy list, through the private AI Gateway; no credential.
//   provider-model   — OpenAI, Anthropic, xAI or Google through the same gateway (binding requests are pre-authenticated), with a vault API key
//                      added to the one outbound request only; the key is never logged, stored elsewhere or returned.
//   coding-cli       — a CLI tool and the credential it uses: a descriptor only; it runs on agent hosts, SSH hosts or later cloud sandboxes.
// Stable interface for the automations framework (keep it stable; docs/ENGINES.md):
//   listEngines(db, env, person, scope) → engine views the person can use there, each with usable and reason
//   resolveEngine(db, env, { person, repository, organizationId, useCase, engineId, place }) → engine handle (throws Fault 412 when refused)
//   runChat(env, engineHandle, messages, options) → { text, usage } for cloudflare-model and provider-model handles
import { Fault, invalid, deny } from './common.mjs';
import { aiModel, aiModelStillAllowed, deployModels, modelOK } from './ai-models.mjs';
import { aiRun, aiUsage } from './ai.mjs';
import { credentialFor, openCredential, vaultSchema, canManageScope, resolveScope, providers, places, credentialViews, subscriptionTools } from './vault.mjs';
import { auditStatement, clientHeaders, locked } from './installation.mjs';
import { ownerSlug } from './owners.mjs';

export const engineKinds = ['cloudflare-model', 'provider-model', 'coding-cli'];
export const cliTools = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', grok: 'Grok Build', agy: 'Antigravity', muse: 'Muse Code' };
// The AI use cases an engine can be chosen for, with the AI models use whose Workers AI model is their default. Uses that are not
// selectable keep their model setting: Clef answers constrained choices with probabilities, agent proposals bind their Workers AI model
// into the proposal policy identity, and search needs embeddings.
export const engineUses = {
  'review-drafts': { label: 'Summaries and review drafts', modelUse: 'review-drafts', selectable: true, detail: 'Pull request review drafts and agentic inbox intent summaries.' },
  'release-notes': { label: 'Release notes', modelUse: 'release-notes', selectable: true, detail: 'Release notes drafts from merged pull requests and commits.' },
  automations: { label: 'Automations', modelUse: 'review-drafts', selectable: true, detail: 'The default engine for automations that use a model; each automation may name its own engine.' },
  triage: { label: 'Issue triage', modelUse: 'triage', selectable: false, reason: 'Clef answers this constrained choice with calibrated probabilities; no other engine can.' },
  advice: { label: 'Review advice', modelUse: 'advice', selectable: false, reason: 'Clef answers this constrained choice with calibrated probabilities; no other engine can.' },
  agents: { label: 'Agent proposals', modelUse: 'agents', selectable: false, reason: 'OpenCode runs agent proposals on Workers AI; the model is bound into each proposal’s policy identity. Choose it in AI models.' },
  search: { label: 'Search embeddings', modelUse: 'search', selectable: false, reason: 'Search needs an embedding model; choose it in AI models.' },
};
const providerModelOK = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value);
const nameOK = name => typeof name === 'string' && name && name.trim() === name && name.length <= 80 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name);
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const time = () => new Date().toISOString();
const refuse = message => { throw new Fault('failed_precondition', 412, message); };
const forbidden = message => { throw new Fault('permission_denied', 403, message); };
const fields = (body, allowed) => Object.keys(body).every(key => allowed.includes(key));
const human = request => !request.headers.has('Authorization') && !request.headers.has('CF-Access-Client-Id') && !request.headers.has('CF-Access-Client-Secret') && Boolean(request.headers.get('X-Golf-Native-Access-Email'));
const gatewayReady = env => Boolean(env.AI?.gateway && env.EVIDENCE_GATEWAY && env.EVIDENCE_ALLOW_AI === 'true');

let migrated = false;
export async function engineSchema(db) {
  if (!migrated) { try { migrated = Boolean((await db.prepare('PRAGMA table_info(engine_selections)').all()).results.length); } catch { migrated = false; } }
  return migrated;
}
export async function engineCapability(db, env) {
  const ready = await engineSchema(db), ai = Boolean(env.AI && env.EVIDENCE_ALLOW_AI === 'true');
  return { id: 'settings.engines', label: 'Engines', state: ready && ai ? 'CAPABILITY_STATE_READY' : 'CAPABILITY_STATE_DISABLED',
    reason: !ready ? 'Apply the schema 45 migration to choose engines.' : !ai ? 'Engines need approved Workers AI on this installation.'
      : 'Choose the engine each AI use case runs at installation, organization and repository level: a Workers AI model, or an OpenAI, Anthropic, xAI or Google model through the private AI Gateway with a vault API key. Without a choice, the Workers AI model chosen in AI models applies. Coding CLI engines are recorded for agent hosts and SSH hosts; cloud sandboxes are not available yet.' +
        (gatewayReady(env) ? '' : ' Provider models are unavailable: the AI Gateway binding or gateway id is missing.') };
}

// ---------- engine views ----------
// Built-in Workers AI engines: one per text-generation model on the deploy list. Their id is workers-ai:<model>.
function builtIns(env) {
  const models = deployModels(env).models, seen = new Set();
  for (const use of ['review-drafts', 'release-notes', 'agents']) for (const model of models[use]?.allowed || []) seen.add(model);
  return [...seen].map(model => builtIn(model));
}
const builtIn = model => ({ id: 'workers-ai:' + model, name: 'Workers AI · ' + model.replace(/^@(?:cf|hf)\//, ''), kind: 'cloudflare-model', provider: 'workers-ai', model, tool: '', places: ['cloud'],
  scope: 'installation', ownerId: '', credential: null, enabled: true, builtIn: true, version: 0 });
const textModels = env => new Set(builtIns(env).map(engine => engine.model));
function engineView(row, credentials = new Map()) {
  const credential = row.credential_id ? credentials.get(row.credential_id) : null;
  return { id: row.id, name: row.name, kind: row.kind, provider: row.provider, model: row.model, tool: row.tool, places: parse(row.places, []), scope: row.scope, ownerId: row.owner_id,
    credential: row.credential_id ? { id: row.credential_id, label: credential?.label || '', kind: credential?.kind || '', state: credential ? credential.revoked_at ? 'revoked' : 'active' : 'missing' } : null,
    enabled: Boolean(row.enabled), builtIn: false, version: row.version, credential_id: row.credential_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
async function credentialMap(db, rows) {
  const ids = [...new Set(rows.map(row => row.credential_id).filter(Boolean))];
  if (!ids.length) return new Map();
  return new Map((await db.prepare('SELECT id,label,kind,revoked_at FROM vault_credentials WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all()).results.map(row => [row.id, row]));
}
async function storedEngine(db, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return null;
  const row = await db.prepare('SELECT * FROM engines WHERE id=?').bind(id).first();
  return row ? engineView(row, await credentialMap(db, [row])) : null;
}
async function engineById(db, env, id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('workers-ai:')) { const model = id.slice(11); return textModels(env).has(model) ? builtIn(model) : null; }
  return storedEngine(db, id);
}
const publicView = ({ credential_id, ...view }) => view;

// The organization a repository belongs to ('' for personal repositories).
async function repositoryOrganization(db, repository) {
  if (!repository) return '';
  if (repository.owner_kind !== undefined) return repository.owner_kind === 'ORGANIZATION' ? String(repository.owner_id) : '';
  const row = await db.prepare("SELECT o.id FROM repository_owners ro JOIN native_owners o ON o.id=ro.owner_id WHERE ro.repository_id=? AND o.kind='ORGANIZATION'").bind(Number(repository.id)).first();
  return row ? String(row.id) : '';
}

/* listEngines(db, env, person, scope?) → [engine view + { usable, reason }]. scope is { repository } (a repository row: installation engines,
 * its organization's engines), { organizationId }, or {} (installation engines); the person's own engines are always included. usable says
 * whether this person may run it now (enabled, credential granted, gateway present); nothing is audited or opened. */
export async function listEngines(db, env, person, scope = {}) {
  const out = builtIns(env).map(engine => ({ ...engine, usable: Boolean(env.AI), reason: env.AI ? '' : 'Workers AI is not bound on this installation.' }));
  if (!await engineSchema(db)) return out;
  const organizationId = scope.organizationId ? String(scope.organizationId) : await repositoryOrganization(db, scope.repository);
  const { results } = await db.prepare(`SELECT * FROM engines WHERE scope='installation' OR scope='organization' AND owner_id=? OR scope='user' AND owner_id=? ORDER BY scope,name,id LIMIT 300`)
    .bind(organizationId || '-', String(person.id)).all();
  const credentials = await credentialMap(db, results);
  for (const row of results) {
    const view = engineView(row, credentials);
    out.push({ ...publicView(view), ...(await usability(db, env, person, view, 'cloud', scope.repository || null)) });
  }
  return out;
}
async function usability(db, env, person, engine, place, repository) {
  if (!engine.enabled) return { usable: false, reason: 'Disabled.' };
  if (engine.kind === 'coding-cli') {
    if (engine.credential_id) { const check = await credentialFor(db, env, { person, engine, place: engine.places[0], repository, dryRun: true }); if (check.refusal) return { usable: false, reason: check.refusal }; }
    return { usable: false, reason: 'Coding CLI engines run on agent hosts and SSH hosts through tasks, not as a model call here.' };
  }
  if (engine.kind === 'provider-model' && !gatewayReady(env)) return { usable: false, reason: 'Provider models need approved AI and the private AI Gateway on this installation.' };
  const check = await credentialFor(db, env, { person, engine, place, repository, dryRun: true });
  return check.refusal ? { usable: false, reason: check.refusal } : { usable: true, reason: '' };
}

// ---------- resolution ----------
const handles = new WeakSet();
function handle(value) { const frozen = Object.freeze(value); handles.add(frozen); return frozen; }
// The default: the Workers AI model AI models chooses for this use, unchanged from before engines.
async function defaultEngine(db, env, use, repository, note = '') {
  const chosen = await aiModel(db, env, engineUses[use].modelUse, repository?.id);
  return handle({ use, engine: builtIn(chosen.model), model: chosen.model, source: chosen.source === 'fixed' ? 'fixed' : 'default', modelSource: chosen.source, note: [note, chosen.note].filter(Boolean).join(' '), credential: null, place: 'cloud' });
}
// Installation, then organization, then repository: each lower level counts only while every level above lets it choose.
async function selectionChain(db, use, organizationId, repositoryId) {
  if (!await engineSchema(db)) return { chosen: null, allowed: { organization: false, repository: false } };
  const { results } = await db.prepare(`SELECT * FROM engine_selections WHERE use_case=? AND (scope='installation' AND scope_id='' OR scope='organization' AND scope_id=? OR scope='repository' AND scope_id=?)`)
    .bind(use, organizationId || '-', repositoryId ? String(repositoryId) : '-').all();
  const at = scope => results.find(row => row.scope === scope);
  const installation = at('installation'), organization = organizationId ? at('organization') : null, repository = repositoryId ? at('repository') : null;
  let chosen = installation?.engine_id ? { engineId: installation.engine_id, source: 'installation' } : null;
  const organizationAllowed = Boolean(installation?.allow_override);
  let repositoryAllowed = organizationAllowed;
  if (organization && organizationAllowed) {
    if (organization.engine_id) chosen = { engineId: organization.engine_id, source: 'organization' };
    repositoryAllowed = Boolean(organization.allow_override);
  }
  if (repository && repositoryAllowed && repository.engine_id) chosen = { engineId: repository.engine_id, source: 'repository' };
  return { chosen, allowed: { organization: organizationAllowed, repository: repositoryAllowed }, rows: { installation, organization, repository } };
}
// The engine must be reachable from where it was chosen: installation engines anywhere, organization engines within that organization.
const reachable = (engine, organizationId) => engine.builtIn || engine.scope === 'installation' || engine.scope === 'organization' && engine.ownerId === organizationId;

/* resolveEngine(db, env, { person, repository?, organizationId?, useCase, engineId?, place = 'cloud', dryRun? }) → a frozen engine handle
 * { use, engine, model, source, note, credential, place } that runChat accepts. source: 'default' (the AI models choice), 'fixed' (Clef),
 * 'installation', 'organization', 'repository' or 'explicit' (engineId given). A selected engine that was disabled, deleted or whose model
 * is no longer allowed falls back to the default with a note; a credential the person may not use refuses with Fault 412 (audited). */
export async function resolveEngine(db, env, { person, repository = null, organizationId, useCase, engineId, place = 'cloud', dryRun = false }) {
  const def = Object.hasOwn(engineUses, useCase) ? engineUses[useCase] : null;
  if (!def) throw Error('Unknown engine use');
  if (!def.selectable) return defaultEngine(db, env, useCase, repository);
  const organization = organizationId !== undefined ? String(organizationId || '') : await repositoryOrganization(db, repository);
  let chosen;
  if (engineId !== undefined) chosen = { engineId, source: 'explicit' };
  else chosen = (await selectionChain(db, useCase, organization, repository?.id)).chosen;
  if (!chosen) return defaultEngine(db, env, useCase, repository);
  const engine = await engineById(db, env, chosen.engineId);
  const fallback = reason => {
    if (chosen.source === 'explicit') refuse(`${def.label}: ${reason}`);
    return defaultEngine(db, env, useCase, repository, `The ${chosen.source} engine choice is not used: ${reason} The default applies.`);
  };
  if (!engine) return fallback('the engine is no longer available.');
  if (!engine.enabled) return fallback(`${engine.name} is disabled.`);
  if (!reachable(engine, organization) && !(chosen.source === 'explicit' && engine.scope === 'user' && engine.ownerId === String(person?.id))) return fallback(`${engine.name} belongs to another organization.`);
  if (engine.kind === 'coding-cli') return fallback(`${engine.name} is a coding CLI engine; it runs tasks on hosts, not model calls.`);
  if (engine.kind === 'cloudflare-model') {
    if (!await aiModelStillAllowed(db, env, def.modelUse, engine.model)) return fallback(`${engine.name} uses ${engine.model}, which AI models no longer allows for ${def.label.toLowerCase()}.`);
    return handle({ use: useCase, engine: publicView(engine), model: engine.model, source: chosen.source, note: '', credential: null, place: 'cloud' });
  }
  if (!gatewayReady(env)) refuse(`${def.label}: provider models need approved AI and the private AI Gateway on this installation.`);
  if (place !== 'cloud') refuse(`${def.label}: provider models run in the cloud place only.`);
  const check = await credentialFor(db, env, { person, engine, place, repository, dryRun });
  if (check.refusal) throw new Fault('failed_precondition', 412, `${def.label}: ${check.refusal}`);
  return handle({ use: useCase, engine: publicView(engine), model: `${engine.provider}/${engine.model}`, source: chosen.source, note: '', credential: check.credential, place });
}
export const engineHandle = value => handles.has(value);

// ---------- provider calls through the AI Gateway ----------
const gatewayProviders = { openai: 'openai', anthropic: 'anthropic', xai: 'grok', google: 'google-ai-studio' };
const schemaNote = input => input.response_format?.json_schema?.schema ? '\n\nAnswer with only one JSON object, no prose and no code fence, that matches this JSON Schema:\n' + JSON.stringify(input.response_format.json_schema.schema) : '';
const messagesOf = input => Array.isArray(input.messages) ? input.messages.filter(m => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role)) : [];
// One request per provider in its own native shape. The key appears only in these headers.
export function providerRequest(provider, model, input, key) {
  const messages = messagesOf(input), max = Number.isInteger(input.max_completion_tokens) ? input.max_completion_tokens : Number.isInteger(input.max_tokens) ? input.max_tokens : undefined;
  const base = { 'cf-aig-skip-cache': 'true', 'cf-aig-collect-log': 'false', 'content-type': 'application/json' };
  if (provider === 'openai') return { provider: 'openai', endpoint: 'chat/completions', headers: { ...base, authorization: 'Bearer ' + key },
    query: { model, messages, ...(max ? { max_completion_tokens: max } : {}), ...(input.response_format ? { response_format: input.response_format } : {}) } };
  if (provider === 'xai') return { provider: 'grok', endpoint: 'v1/chat/completions', headers: { ...base, authorization: 'Bearer ' + key },
    query: { model, messages, ...(max ? { max_tokens: max } : {}), ...(input.response_format ? { response_format: input.response_format } : {}) } };
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') + schemaNote(input), turns = messages.filter(m => m.role !== 'system');
  if (provider === 'anthropic') return { provider: 'anthropic', endpoint: 'v1/messages', headers: { ...base, 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    query: { model, max_tokens: max || 4096, ...(system ? { system } : {}), messages: turns.map(m => ({ role: m.role, content: m.content })) } };
  if (provider === 'google') return { provider: 'google-ai-studio', endpoint: `v1beta/models/${encodeURIComponent(model)}:generateContent`, headers: { ...base, 'x-goog-api-key': key },
    query: { contents: turns.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { ...(max ? { maxOutputTokens: max } : {}), ...(input.response_format ? { responseMimeType: 'application/json' } : {}) } } };
  throw Error('Unknown provider');
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
// Every answer becomes the chat-completions shape the AI kinds already read: choices[0].message.content, finish_reason and usage counts.
export function providerAnswer(provider, answer) {
  if (provider === 'openai' || provider === 'xai') {
    const choice = answer?.choices?.[0];
    if (!choice) throw Error('The provider answered without a choice');
    const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
    return { choices: [{ message: { role: 'assistant', content }, finish_reason: String(choice.finish_reason || 'stop') }],
      usage: clean({ prompt_tokens: count(answer.usage?.prompt_tokens), completion_tokens: count(answer.usage?.completion_tokens), total_tokens: count(answer.usage?.total_tokens) }) };
  }
  if (provider === 'anthropic') {
    const content = (Array.isArray(answer?.content) ? answer.content : []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
    const finish = ['end_turn', 'stop_sequence'].includes(answer?.stop_reason) ? 'stop' : answer?.stop_reason === 'max_tokens' ? 'length' : String(answer?.stop_reason || 'stop');
    return { choices: [{ message: { role: 'assistant', content }, finish_reason: finish }], usage: clean({ input_tokens: count(answer?.usage?.input_tokens), output_tokens: count(answer?.usage?.output_tokens) }) };
  }
  const candidate = answer?.candidates?.[0];
  const content = (candidate?.content?.parts || []).filter(part => typeof part?.text === 'string').map(part => part.text).join('');
  const finish = candidate?.finishReason === 'STOP' ? 'stop' : candidate?.finishReason === 'MAX_TOKENS' ? 'length' : String(candidate?.finishReason || 'stop').toLowerCase();
  const usage = answer?.usageMetadata || {};
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    usage: clean({ prompt_tokens: count(usage.promptTokenCount), completion_tokens: count(usage.candidatesTokenCount), total_tokens: count(usage.totalTokenCount) }) };
}
async function providerCall(env, engine, credential, input, { deadlineMs = 140_000 } = {}) {
  const key = await openCredential(env, credential);
  let timer;
  try {
    const request = providerRequest(engine.provider, engine.model, input, key);
    const response = await Promise.race([env.AI.gateway(env.EVIDENCE_GATEWAY).run(request),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Inference deadline')), deadlineMs); })]);
    if (!response?.ok) throw Error(`${providers[engine.provider]} answered HTTP ${response?.status ?? 'without a status'} through the AI Gateway`);
    return providerAnswer(engine.provider, await response.json());
  } catch (error) {
    // The key never leaves in an error: provider messages that echo part of a request are cut down to a fixed text.
    const message = String(error?.message || 'Provider call failed').split(key).join('***');
    throw Error(/^(?:Inference deadline|.* answered HTTP .*|The provider answered without a choice)$/.test(message) ? message : `${providers[engine.provider]} call failed`);
  } finally { clearTimeout(timer); }
}
// The raw call the AI kinds use: Workers AI input in, a chat-completions shaped answer out.
export async function engineCall(env, engineHandle, input, options) {
  if (!handles.has(engineHandle)) throw Error('Not a resolved engine handle');
  const { engine } = engineHandle;
  if (engine.kind === 'cloudflare-model') return aiRun(env, engineHandle.model, input, options);
  if (engine.kind === 'provider-model') return providerCall(env, engine, engineHandle.credential, input, options);
  throw new Fault('failed_precondition', 412, 'Coding CLI engines run tasks on agent hosts or SSH hosts, not model calls.');
}
/* runChat(env, engineHandle, messages, { maxTokens, responseFormat, deadlineMs }) → { text, usage }. messages: [{ role, content }].
 * usage holds exactly the token counts the model reported. Throws for coding-cli handles and handles not issued by resolveEngine. */
export async function runChat(env, engineHandle, messages, options = {}) {
  if (!Array.isArray(messages) || !messages.length) throw Error('runChat needs messages');
  const input = { messages, ...(Number.isInteger(options.maxTokens) ? { max_completion_tokens: options.maxTokens } : {}), ...(options.responseFormat ? { response_format: options.responseFormat } : {}) };
  const answer = await engineCall(env, engineHandle, input, { deadlineMs: options.deadlineMs });
  const choice = answer?.choices?.[0];
  let text = choice ? choice.message?.content : answer?.response;
  if (text && typeof text === 'object') text = JSON.stringify(text);
  return { text: typeof text === 'string' ? text : '', usage: aiUsage(answer), finishReason: choice?.finish_reason || 'stop' };
}

// ---------- AI runs: the engine an admitted run uses, re-checked before inference ----------
export async function recordRunEngine(db, run, engineHandle) {
  if (!engineHandle || engineHandle.engine.builtIn) return;
  await db.prepare('INSERT OR IGNORE INTO ai_run_engines(run_id,engine_id,engine_version,credential_id,credential_label,created_at) VALUES(?,?,?,?,?,?)')
    .bind(run.id, engineHandle.engine.id, engineHandle.engine.version, engineHandle.credential?.id || null, engineHandle.credential?.label || '', time()).run();
}
/* For a run admitted with a stored engine: { handle } when it may still run, { refusal } otherwise, or null for a default-model run.
 * dryRun (prepare) checks without auditing; inference (dryRun false) audits a refused credential. */
export async function runEngine(db, env, run, { dryRun = true } = {}) {
  if (!await engineSchema(db)) return null;
  const row = await db.prepare('SELECT * FROM ai_run_engines WHERE run_id=?').bind(run.id).first();
  if (!row) return null;
  const engine = await storedEngine(db, row.engine_id);
  if (!engine || !engine.enabled || engine.version !== row.engine_version) return { refusal: 'The engine this run was admitted with changed or was disabled; nothing was billed.' };
  const person = await db.prepare('SELECT id,login FROM users WHERE id=?').bind(run.user_id).first();
  const repository = await db.prepare(`SELECT r.id,o.kind AS owner_kind,o.id AS owner_id FROM repositories r LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE r.id=?`).bind(run.repository_id).first();
  if (engine.kind === 'cloudflare-model') return { handle: handle({ use: '', engine: publicView(engine), model: engine.model, source: 'run', note: '', credential: null, place: 'cloud' }) };
  if (engine.kind !== 'provider-model' || !gatewayReady(env)) return { refusal: 'Provider models are no longer available on this installation; nothing was billed.' };
  const check = await credentialFor(db, env, { person: person || { id: run.user_id }, engine, place: 'cloud', repository, dryRun });
  if (check.refusal) return { refusal: check.refusal.replace(/\.$/, '') + '; nothing was billed.' };
  return { handle: handle({ use: '', engine: publicView(engine), model: `${engine.provider}/${engine.model}`, source: 'run', note: '', credential: check.credential, place: 'cloud' }) };
}

// ---------- API: /native/engines ----------
const selectionScopes = ['installation', 'organization', 'repository'];
async function manager(db, person, request, scope, ownerId) {
  if (scope === 'repository') return false;
  return canManageScope(db, person, request, scope, ownerId);
}
async function validEngine(db, env, scope, body, current) {
  const kind = current?.kind ?? body.kind;
  if (!engineKinds.includes(kind)) invalid('Choose a Cloudflare model, a provider model or a coding CLI.');
  const name = body.name ?? current?.name, model = body.model ?? current?.model ?? '', credentialId = body.credentialId !== undefined ? body.credentialId || null : current?.credential_id ?? null;
  const where = body.places ?? current?.places ?? (kind === 'coding-cli' ? ['agent-host', 'ssh-host'] : ['cloud']);
  if (!nameOK(name)) invalid('Use a trimmed name up to 80 characters.');
  if (!Array.isArray(where) || !where.length || new Set(where).size !== where.length || where.some(place => !places.includes(place))) invalid('Choose where it runs: cloud, agent-host or ssh-host.');
  let provider = current?.provider ?? body.provider ?? '', tool = current?.tool ?? body.tool ?? '';
  if (kind === 'cloudflare-model') {
    if (!modelOK(model) || !textModels(env).has(model)) invalid('Choose a Workers AI text model on this installation’s deploy list.');
    if (credentialId) invalid('Workers AI models need no credential.');
    provider = 'workers-ai'; tool = '';
    if (where.some(place => place !== 'cloud')) invalid('Workers AI models run in the cloud place only.');
  } else if (kind === 'provider-model') {
    if (!Object.hasOwn(providers, provider)) invalid('Choose OpenAI, Anthropic, xAI or Google.');
    if (!providerModelOK(model)) invalid('Name the provider model, for example gpt-5 or claude-sonnet-4-5.');
    if (where.some(place => place !== 'cloud')) invalid('Provider models run in the cloud place only.');
    if (!credentialId) invalid('Choose the API key this engine uses.');
    tool = '';
  } else {
    if (!Object.hasOwn(cliTools, tool)) invalid('Choose the coding CLI: codex, claude, opencode, grok, agy or muse.');
    if (model && !providerModelOK(model)) invalid('Use a model name of letters, digits and . _ : / -.');
    provider = '';
  }
  if (credentialId) {
    const credential = await db.prepare('SELECT * FROM vault_credentials WHERE id=?').bind(String(credentialId)).first();
    if (!credential || credential.revoked_at || credential.scope !== scope.scope || credential.owner_id !== scope.ownerId) invalid('Choose an active credential from this same scope.');
    if (kind === 'provider-model' && (credential.kind !== 'api-key' || credential.provider !== provider)) invalid(`Choose a ${providers[provider]} API key.`);
    if (kind === 'coding-cli' && credential.kind === 'subscription' && credential.tool !== tool && credential.tool !== 'opencode') invalid('Choose a sign-in that belongs to this coding CLI.');
  }
  const enabled = body.enabled ?? (current ? Boolean(current.enabled) : true);
  if (typeof enabled !== 'boolean') invalid('Enabled is true or false.');
  return { name, kind, provider, model, tool, credentialId, places: places.filter(place => where.includes(place)), enabled };
}
const actor = (person, request) => ({ actor: person, actorEmail: request.headers.get('X-Golf-Native-Access-Email') || '', client: clientHeaders(request) });
const auditScope = (env, scope, ownerId) => scope === 'organization' ? { scope: 'organization', scopeId: ownerId } : scope === 'repository' ? { scope: 'repository', scopeId: ownerId } : { scope: 'installation', scopeId: env.WORKSPACE_SLUG || '' };
const engineSummary = value => ({ name: value.name, kind: value.kind, provider: value.provider || undefined, model: value.model || undefined, tool: value.tool || undefined, places: value.places, enabled: value.enabled });

async function selectionScope(db, env, person, request, body, repository) {
  if (!selectionScopes.includes(body.scope)) invalid('Choose installation, organization or repository.');
  if (body.scope === 'repository') {
    const row = await repository();
    const organizationId = await repositoryOrganization(db, row);
    return { scope: 'repository', scopeId: String(row.id), organizationId, repository: row, label: `${ownerSlug(row, env)}/${row.name}`, canEdit: row.role === 'admin' && human(request) && !locked(env) };
  }
  const resolved = await resolveScope(db, person, body);
  const canEdit = await canManageScope(db, person, request, resolved.scope, resolved.ownerId) && !(resolved.scope === 'installation' && locked(env));
  return { scope: resolved.scope, scopeId: resolved.ownerId, organizationId: resolved.scope === 'organization' ? resolved.ownerId : '', repository: null, label: resolved.label, canEdit };
}
async function usesView(db, env, person, where) {
  const uses = [];
  for (const [use, def] of Object.entries(engineUses)) {
    if (!def.selectable) { uses.push({ use, label: def.label, selectable: false, reason: def.reason }); continue; }
    const chain = await selectionChain(db, use, where.organizationId, where.repository?.id);
    const own = chain.rows?.[where.scope] || null;
    const allowed = where.scope === 'installation' ? true : where.scope === 'organization' ? chain.allowed.organization : chain.allowed.repository;
    let effective;
    try {
      const resolved = await resolveEngine(db, env, { person, repository: where.repository, organizationId: where.organizationId, useCase: use, dryRun: true });
      effective = { engineId: resolved.engine.id, engineName: resolved.engine.name, kind: resolved.engine.kind, model: resolved.model, source: resolved.source, note: resolved.note, refusal: '' };
    } catch (error) { if (!(error instanceof Fault)) throw error; effective = { engineId: '', engineName: '', kind: '', model: '', source: 'refused', note: '', refusal: error.message }; }
    uses.push({ use, label: def.label, detail: def.detail, selectable: true, allowedHere: allowed, reason: allowed ? '' : where.scope === 'organization' ? 'The installation does not let organizations choose this engine.' : 'The installation or organization does not let repositories choose this engine.',
      selection: own ? { engineId: own.engine_id, allowOverride: Boolean(own.allow_override), version: own.version, updatedAt: own.updated_at } : { engineId: '', allowOverride: false, version: 0, updatedAt: '' }, effective });
  }
  return uses;
}
// Engines a selection at this scope may name: built-ins, installation engines and (organization, repository) the organization's engines.
async function selectable(db, env, where) {
  const { results } = await db.prepare("SELECT * FROM engines WHERE enabled=1 AND kind IN ('cloudflare-model','provider-model') AND (scope='installation' OR scope='organization' AND owner_id=?) ORDER BY scope,name").bind(where.organizationId || '-').all();
  const credentials = await credentialMap(db, results);
  return [...builtIns(env), ...results.map(row => publicView(engineView(row, credentials)))];
}

export async function enginesAPI(db, env, person, request, body, repository) {
  if (!await engineSchema(db)) refuse('Engines need the schema 45 migration on this installation.');
  const action = body.action;
  if (action === 'list') {
    if (body.scope === 'user') {
      const engines = (await db.prepare("SELECT * FROM engines WHERE scope='user' AND owner_id=? ORDER BY name,id LIMIT 100").bind(String(person.id)).all()).results;
      const credentials = await credentialMap(db, engines), vault = await vaultSchema(db) ? (await db.prepare("SELECT * FROM vault_credentials WHERE scope='user' AND owner_id=? AND revoked_at IS NULL ORDER BY label").bind(String(person.id)).all()).results : [];
      return { scope: { scope: 'user', label: person.login }, engines: engines.map(row => publicView(engineView(row, credentials))), uses: [], selectable: [], canManage: true, canSelect: false,
        credentials: (await credentialViews(db, env, vault)).map(({ grants, ...rest }) => rest), ...catalog(env) };
    }
    const where = await selectionScope(db, env, person, request, body, repository);
    if (where.scope === 'repository' && where.repository.role === 'public') deny();
    const manage = await manager(db, person, request, where.scope, where.scopeId);
    if (where.scope === 'organization' && !manage && !await db.prepare('SELECT 1 AS ok FROM native_owner_members WHERE owner_id=? AND user_id=?').bind(Number(where.scopeId), person.id).first()) forbidden('Organization members read organization engines.');
    if (where.scope === 'installation' && !manage) forbidden('Current workspace operations administrator sign-in required.');
    const stored = where.scope === 'repository' ? [] : (await db.prepare('SELECT * FROM engines WHERE scope=? AND owner_id=? ORDER BY name,id LIMIT 100').bind(where.scope, where.scopeId).all()).results;
    const credentials = await credentialMap(db, stored);
    const vault = where.scope !== 'repository' && manage && await vaultSchema(db) ? (await db.prepare('SELECT * FROM vault_credentials WHERE scope=? AND owner_id=? AND revoked_at IS NULL ORDER BY label').bind(where.scope, where.scopeId).all()).results : [];
    return { scope: { scope: where.scope, scopeId: where.scopeId, label: where.label }, engines: stored.map(row => publicView(engineView(row, credentials))), builtIn: builtIns(env),
      uses: await usesView(db, env, person, where), selectable: await selectable(db, env, where), canManage: manage && !(where.scope === 'installation' && locked(env)), canSelect: where.canEdit,
      credentials: (await credentialViews(db, env, vault)).map(({ grants, ...rest }) => rest), ...catalog(env) };
  }
  if (!human(request)) forbidden('Change engines from a signed-in browser session.');
  if (action === 'create') {
    if (!fields(body, ['action', 'scope', 'organization', 'name', 'kind', 'provider', 'model', 'tool', 'credentialId', 'places', 'enabled'])) invalid('Unknown field.');
    const scope = await resolveScope(db, person, body);
    if (!await canManageScope(db, person, request, scope.scope, scope.ownerId)) forbidden('You cannot manage engines in this scope.');
    if (scope.scope === 'installation' && locked(env)) refuse('Installation policy is locked at deploy (policy_editing: false); engines cannot change.');
    const value = await validEngine(db, env, scope, body, null);
    const counted = await db.prepare('SELECT COUNT(*) AS n FROM engines WHERE scope=? AND owner_id=?').bind(scope.scope, scope.ownerId).first();
    if (counted.n >= 100) refuse('This scope already has 100 engines.');
    const id = crypto.randomUUID(), stamp = time();
    await db.batch([
      db.prepare('INSERT INTO engines(id,scope,owner_id,name,kind,provider,model,tool,credential_id,places,enabled,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)')
        .bind(id, scope.scope, scope.ownerId, value.name, value.kind, value.provider, value.model, value.tool, value.credentialId, JSON.stringify(value.places), value.enabled ? 1 : 0, person.id, stamp, person.id, stamp),
      auditStatement(db, { ...actor(person, request), ...auditScope(env, scope.scope, scope.ownerId), subject: value.name, action: 'engine.create', after: engineSummary(value) }),
    ]);
    return { engine: publicView(await storedEngine(db, id)) };
  }
  if (action === 'update' || action === 'delete') {
    const current = typeof body.id === 'string' && /^[a-f0-9-]{36}$/.test(body.id) ? await db.prepare('SELECT * FROM engines WHERE id=?').bind(body.id).first() : null;
    if (!current) deny();
    if (!await canManageScope(db, person, request, current.scope, current.owner_id)) forbidden('You cannot manage engines in this scope.');
    if (current.scope === 'installation' && locked(env)) refuse('Installation policy is locked at deploy (policy_editing: false); engines cannot change.');
    if (action === 'delete') {
      const used = await db.prepare('SELECT scope,use_case FROM engine_selections WHERE engine_id=? LIMIT 1').bind(current.id).first();
      if (used) refuse(`${current.name} is selected for ${engineUses[used.use_case]?.label.toLowerCase() || used.use_case} at ${used.scope} level; choose another engine there first, or disable it.`);
      await db.batch([db.prepare('DELETE FROM engines WHERE id=?').bind(current.id),
        auditStatement(db, { ...actor(person, request), ...auditScope(env, current.scope, current.owner_id), subject: current.name, action: 'engine.delete' })]);
      return { ok: true };
    }
    if (!fields(body, ['action', 'id', 'expectedVersion', 'name', 'model', 'credentialId', 'places', 'enabled'])) invalid('Unknown field.');
    if (body.expectedVersion !== current.version) refuse('The engine changed; refresh before saving.');
    const value = await validEngine(db, env, { scope: current.scope, ownerId: current.owner_id }, body, { ...current, places: parse(current.places, []) });
    const saved = await db.batch([
      db.prepare('UPDATE engines SET name=?,model=?,credential_id=?,places=?,enabled=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=?')
        .bind(value.name, value.model, value.credentialId, JSON.stringify(value.places), value.enabled ? 1 : 0, person.id, time(), current.id, current.version),
      auditStatement(db, { ...actor(person, request), ...auditScope(env, current.scope, current.owner_id), subject: value.name, action: 'engine.update', before: engineSummary({ ...current, places: parse(current.places, []), enabled: Boolean(current.enabled) }), after: engineSummary(value) }),
    ]);
    if (saved[0].meta.changes !== 1) refuse('The engine changed; refresh before saving.');
    return { engine: publicView(await storedEngine(db, current.id)) };
  }
  if (action === 'select') {
    if (!fields(body, ['action', 'scope', 'organization', 'repository', 'repositoryId', 'use', 'engineId', 'allowOverride', 'expectedVersion'])) invalid('Unknown field.');
    const where = await selectionScope(db, env, person, request, body, repository);
    if (!where.canEdit) forbidden(where.scope === 'repository' ? 'Repository engines change only under a verified Access sign-in by a current repository administrator.' : where.scope === 'installation' && locked(env) ? 'Installation policy is locked at deploy (policy_editing: false).' : 'You cannot choose engines here.');
    const def = Object.hasOwn(engineUses, body.use) ? engineUses[body.use] : null;
    if (!def?.selectable) invalid(def ? def.reason : 'Choose an AI use case.');
    if (typeof body.engineId !== 'string' || typeof body.allowOverride !== 'boolean' || !Number.isInteger(body.expectedVersion)) invalid('Choose an engine (or none to follow the level above), whether the levels below may choose, and the version you read.');
    const chain = await selectionChain(db, body.use, where.organizationId, where.repository?.id);
    if (where.scope === 'organization' && !chain.allowed.organization) refuse(`The installation does not let organizations choose the ${def.label.toLowerCase()} engine.`);
    if (where.scope === 'repository' && !chain.allowed.repository) refuse(`The installation or organization does not let repositories choose the ${def.label.toLowerCase()} engine.`);
    if (where.scope === 'repository' && body.allowOverride) invalid('Nothing lies below a repository.');
    if (body.engineId) {
      const engine = await engineById(db, env, body.engineId);
      if (!engine || !engine.enabled || engine.kind === 'coding-cli' || !reachable(engine, where.organizationId)) invalid('Choose an enabled model engine from this installation or this organization.');
      if (engine.kind === 'cloudflare-model' && !await aiModelStillAllowed(db, env, def.modelUse, engine.model)) invalid(`${engine.model} is not allowed for ${def.label.toLowerCase()} in AI models.`);
    }
    const current = chain.rows?.[where.scope];
    if ((current?.version || 0) !== body.expectedVersion) refuse('This engine choice changed since you read it. Refresh before editing.');
    const before = current ? { engineId: current.engine_id, allowOverride: Boolean(current.allow_override) } : null, after = { engineId: body.engineId, allowOverride: body.allowOverride };
    const widening = Boolean(body.allowOverride && !current?.allow_override);
    const saved = await db.batch([
      db.prepare(`INSERT INTO engine_selections(scope,scope_id,use_case,engine_id,allow_override,version,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(scope,scope_id,use_case) DO UPDATE SET engine_id=excluded.engine_id,allow_override=excluded.allow_override,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE engine_selections.version=?`)
        .bind(where.scope, where.scope === 'installation' ? '' : where.scopeId, body.use, body.engineId, body.allowOverride ? 1 : 0, body.expectedVersion + 1, person.id, time(), body.expectedVersion),
      auditStatement(db, { ...actor(person, request), ...auditScope(env, where.scope, where.scopeId), subject: 'engine:' + body.use, action: 'engine_selection.update', before, after, widening }),
    ]);
    if (saved[0].meta.changes !== 1) refuse('This engine choice changed since you read it. Refresh before editing.');
    return { uses: await usesView(db, env, person, where) };
  }
  invalid('Use list, create, update, delete or select.');
}
const catalog = env => ({ kinds: engineKinds, providers: Object.entries(providers).map(([id, label]) => ({ id, label })), tools: Object.entries(cliTools).map(([id, label]) => ({ id, label, signIn: subscriptionTools[id]?.label || '' })),
  places, workersAiModels: [...textModels(env)], gateway: gatewayReady(env) });
