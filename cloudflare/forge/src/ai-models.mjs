import { Fault, reply, invalid, uuidOK, digest } from './common.mjs';
import { operationsAdmin } from './operations.mjs';
import { auditStatement, clientHeaders, locked } from './installation.mjs';
import { settingsAuthority } from './repository-settings.mjs';
import { policyIdentity } from '../../agents/src/policy.mjs';

// Which Workers AI model each AI use case runs. The deploy-time list AI_MODELS is the ceiling; an operations administrator picks the
// default and the allowed models inside it from the account's catalog; repositories choose from the allowed list only where the
// administrator allows overrides. Clef answers constrained-choice questions with calibrated probabilities, so advice and triage keep it.
const clef = '@cf/cloudflare/clef';
export const aiUses = {
  agents: { label: 'Agent proposals', task: 'Text Generation', needs: 'function_calling', needsLabel: 'function calling', feature: 'agents',
    detail: 'OpenCode edits the approved file through tool calls in an isolated fork. The model is part of each proposal’s policy identity.' },
  advice: { label: 'Review advice', fixed: clef, feature: 'advice', detail: 'One constrained question about the next review step, answered with a probability for each option.' },
  'review-drafts': { label: 'Summaries and review drafts', task: 'Text Generation', feature: 'ai-review-drafts', detail: 'Reads a bounded pull request diff and drafts a summary and review notes as strict JSON.' },
  triage: { label: 'Issue triage', fixed: clef, feature: 'ai-triage', detail: 'Ranks up to 20 of the repository’s own labels for an issue with probabilities.' },
  'release-notes': { label: 'Release notes', task: 'Text Generation', feature: 'ai-release-notes', detail: 'Drafts grouped release notes from merged pull requests and commits as strict JSON.' },
  search: { label: 'Search embeddings', task: 'Text Embeddings', feature: 'semantic-search', embedding: true, detail: 'Embeds code and discussion chunks for semantic search. Changing it re-indexes every repository.' },
};
// Used only when the deploy sets no AI_MODELS (installations prepared before model selection existed).
export const builtInModels = {
  agents: { default: '@cf/zai-org/glm-5.3-flash', allowed: ['@cf/zai-org/glm-5.3-flash', '@cf/zai-org/glm-5.3'] },
  'review-drafts': { default: '@cf/zai-org/glm-5.3', allowed: ['@cf/zai-org/glm-5.3', '@cf/zai-org/glm-5.3-flash', '@cf/zai-org/glm-5.2'] },
  'release-notes': { default: '@cf/zai-org/glm-5.3', allowed: ['@cf/zai-org/glm-5.3', '@cf/zai-org/glm-5.3-flash', '@cf/zai-org/glm-5.2'] },
  search: { default: '@cf/qwen/qwen3-embedding-0.6b', allowed: ['@cf/qwen/qwen3-embedding-0.6b', '@cf/baai/bge-m3'] },
};
export const modelOK = value => typeof value === 'string' && /^@(?:cf|hf)\/[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,95}$/i.test(value);
const configurable = Object.keys(aiUses).filter(use => !aiUses[use].fixed);
const catalogHours = 6, maxAllowed = 16;
const time = () => new Date().toISOString();
const settingKey = use => 'ai.model.' + use;
const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };

// The deploy ceiling, validated the same way prepare.mjs validates it. An invalid value allows nothing rather than falling back to wider defaults.
export function validModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(use => !configurable.includes(use))) return null;
  const out = {};
  for (const [use, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['default', 'allowed', 'dimensions'].includes(key)) || !Array.isArray(entry.allowed) ||
        !entry.allowed.length || entry.allowed.length > maxAllowed || !entry.allowed.every(modelOK) || new Set(entry.allowed).size !== entry.allowed.length || !entry.allowed.includes(entry.default)) return null;
    if (entry.dimensions !== undefined && (!aiUses[use].embedding || !entry.dimensions || typeof entry.dimensions !== 'object' ||
        Object.entries(entry.dimensions).some(([model, size]) => !entry.allowed.includes(model) || !Number.isInteger(size) || size < 32 || size > 4096))) return null;
    out[use] = { default: entry.default, allowed: [...entry.allowed], ...(entry.dimensions ? { dimensions: { ...entry.dimensions } } : {}) };
  }
  return out;
}
export function deployModels(env) {
  if (env.AI_MODELS === undefined) return { valid: true, source: 'built-in', models: builtInModels };
  const models = validModels(parse(env.AI_MODELS));
  return models ? { valid: true, source: 'deploy', models } : { valid: false, source: 'deploy', models: {} };
}

// Installation choice for one use, narrowed to the deploy ceiling. Locked installations and missing rows read the deploy value.
function settingValue(env, use, row) {
  const ceiling = deployModels(env).models[use];
  if (!ceiling) return null;
  const deploy = { default: ceiling.default, allowed: [...ceiling.allowed], repositoryOverride: false };
  const saved = row && !locked(env) ? parse(row.value) : undefined;
  if (!saved) return { value: deploy, deploy, source: 'deploy', unreadable: Boolean(row && !locked(env)), ceiling };
  if (!saved || !Array.isArray(saved.allowed) || typeof saved.repositoryOverride !== 'boolean' || !modelOK(saved.default)) return { value: deploy, deploy, source: 'deploy', unreadable: true, ceiling };
  const allowed = saved.allowed.filter(model => ceiling.allowed.includes(model));
  // A saved default the deploy no longer lists falls back to the deploy default.
  const value = allowed.includes(saved.default) ? { default: saved.default, allowed, repositoryOverride: saved.repositoryOverride }
    : { default: ceiling.default, allowed: allowed.includes(ceiling.default) ? allowed : [ceiling.default, ...allowed], repositoryOverride: saved.repositoryOverride };
  return { value, deploy, source: 'installation', unreadable: false, ceiling, narrowed: value.default !== saved.default || allowed.length !== saved.allowed.length };
}
async function settingRows(db) {
  try { return new Map((await db.prepare("SELECT s.key,s.value,s.version,s.updated_at,u.login AS updated_by FROM installation_settings s LEFT JOIN users u ON u.id=s.updated_by WHERE s.key LIKE 'ai.model.%'").all()).results.map(row => [row.key, row])); }
  catch { return null; }
}
async function retiredModels(db) {
  try { return new Set((await db.prepare('SELECT model FROM ai_model_catalog WHERE retired_at IS NOT NULL').all()).results.map(row => row.model)); }
  catch { return new Set(); }
}

/* aiModel(db, env, use, repositoryId?) → { use, model, source, note }: the one helper every AI kind calls for its model.
 * source is 'fixed' (Clef), 'repository' (this repository's allowed choice), 'installation' (the administrator's default) or 'deploy'.
 * A repository choice that is no longer allowed, or a retired default, falls back with a note; with nothing usable it throws 412.
 * Record the returned model on the run (ai_runs.model, agent results) and call aiModelStillAllowed before inference. */
export async function aiModel(db, env, use, repositoryId) {
  const def = Object.hasOwn(aiUses, use) ? aiUses[use] : null;
  if (!def) throw Error('Unknown AI use');
  if (def.fixed) return { use, model: def.fixed, source: 'fixed', note: '' };
  const rows = await settingRows(db), setting = settingValue(env, use, rows?.get(settingKey(use)));
  if (!setting) throw new Fault('failed_precondition', 412, `${def.label}: this installation’s deploy lists no Workers AI model for it.`);
  const retired = await retiredModels(db), usable = model => setting.value.allowed.includes(model) && !retired.has(model);
  let note = '';
  if (setting.value.repositoryOverride && repositoryId !== undefined && repositoryId !== null) {
    let choice = null;
    try { choice = await db.prepare('SELECT model FROM repository_ai_models WHERE repository_id=? AND use=?').bind(Number(repositoryId), use).first(); } catch {}
    if (choice?.model && usable(choice.model)) return { use, model: choice.model, source: 'repository', note: '' };
    if (choice?.model) note = `This repository’s choice ${choice.model} is no longer allowed, so the installation default applies.`;
  }
  if (usable(setting.value.default)) return { use, model: setting.value.default, source: setting.source, note };
  const fallback = setting.ceiling.default;
  if (!retired.has(fallback)) return { use, model: fallback, source: 'deploy', note: `${note} ${setting.value.default} was retired, so the deploy default applies.`.trim() };
  throw new Fault('failed_precondition', 412, `${def.label}: no allowed Workers AI model is available. An operations administrator must choose another in AI models.`);
}
// At reservation and again at inference: the admitted model is still on the deploy list, still allowed here and not retired.
export async function aiModelStillAllowed(db, env, use, model) {
  const def = aiUses[use];
  if (!def) return false;
  if (def.fixed) return model === def.fixed;
  const setting = settingValue(env, use, (await settingRows(db))?.get(settingKey(use)));
  if (!setting || (await retiredModels(db)).has(model)) return false;
  return setting.value.allowed.includes(model) || model === setting.ceiling.default;
}

// The agent model is bound into the policy identity: AGENT_POLICY_SHA256 (deploy, without a model) and the model hash to the identity
// recorded at admission, so a model change refuses queued and running proposals at their next step. The agents Worker recomputes it.
export async function withAgentModel(db, env, repositoryId) {
  if (!/^[a-f0-9]{64}$/.test(env.AGENT_POLICY_SHA256 || '') || env.AGENT_DEPLOY_POLICY_SHA256) return env;
  try {
    const { model } = await aiModel(db, env, 'agents', repositoryId);
    return { ...env, AGENT_MODEL: model, AGENT_DEPLOY_POLICY_SHA256: env.AGENT_POLICY_SHA256, AGENT_POLICY_SHA256: await policyIdentity(env.AGENT_POLICY_SHA256, model) };
  } catch (error) {
    if (!(error instanceof Fault)) throw error;
    return { ...env, AGENT_EXECUTION_ENABLED: 'false', AGENT_MODEL_REFUSAL: error.message };
  }
}

// Catalog: env.AI.models({ task }) needs no credential. Rows are kept 6 hours; a model that disappears or passes its planned
// deprecation date is marked retired. Property ids are not documented as stable, so anything unrecognised is "unverified".
function catalogEntry(raw, task) {
  const model = raw?.name;
  if (!modelOK(model) || (raw.task?.name ?? raw.task) !== task) return null;
  const properties = {};
  for (const item of Array.isArray(raw.properties) ? raw.properties.slice(0, 40) : []) {
    const id = typeof item?.property_id === 'string' ? item.property_id : '';
    if (!/^[a-z0-9_]{1,64}$/.test(id)) continue;
    const value = Array.isArray(item.value) ? item.value.slice(0, 4).map(part => part && typeof part === 'object' ? { unit: String(part.unit ?? '').slice(0, 60), price: Number(part.price), currency: String(part.currency ?? '').slice(0, 8) } : String(part).slice(0, 60))
      : String(item.value ?? '').slice(0, 120);
    properties[id] = value;
  }
  return { model, task, description: String(raw.description ?? '').replace(/\s+/g, ' ').slice(0, 300), properties };
}
const retiredByDate = entry => /^\d{4}-\d{2}-\d{2}/.test(entry.properties.planned_deprecation_date || '') && entry.properties.planned_deprecation_date.slice(0, 10) <= time().slice(0, 10);
export async function refreshCatalog(db, env, force = false) {
  if (!env.AI?.models) return { refreshed: 0, reason: 'The Workers AI binding is not present on this installation.' };
  const tasks = [...new Set(configurable.map(use => aiUses[use].task))];
  let refreshed = 0;
  for (const task of tasks) {
    const prior = await db.prepare('SELECT * FROM ai_model_catalog_reads WHERE task=?').bind(task).first();
    if (prior?.attempted_at > new Date(Date.now() - 60_000).toISOString()) continue;
    if (!force && prior?.read_at > new Date(Date.now() - catalogHours * 3600_000).toISOString()) continue;
    const stamp = time();
    await db.prepare("INSERT INTO ai_model_catalog_reads(task,attempted_at,state) VALUES(?,?,'running') ON CONFLICT(task) DO UPDATE SET attempted_at=excluded.attempted_at,state='running',reason=NULL").bind(task, stamp).run();
    let timer;
    try {
      const listed = await Promise.race([env.AI.models({ task }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('The catalog did not answer within 8 seconds.')), 8000); })]);
      if (!Array.isArray(listed) || listed.length > 2000) throw Error('The catalog answer was not a model list.');
      const entries = [...new Map(listed.map(raw => catalogEntry(raw, task)).filter(Boolean).map(entry => [entry.model, entry])).values()];
      // An empty answer is not evidence that every model was removed.
      if (!entries.length) throw Error(`The catalog listed no ${task} models.`);
      for (const entry of entries) await db.prepare(`INSERT INTO ai_model_catalog(model,task,description,properties,first_seen,last_seen,retired_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(model) DO UPDATE SET task=excluded.task,description=excluded.description,properties=excluded.properties,last_seen=excluded.last_seen,retired_at=CASE WHEN excluded.retired_at IS NULL THEN NULL ELSE COALESCE(ai_model_catalog.retired_at,excluded.retired_at) END`)
        .bind(entry.model, task, entry.description, JSON.stringify(entry.properties), stamp, stamp, retiredByDate(entry) ? stamp : null).run();
      await db.prepare('UPDATE ai_model_catalog SET retired_at=? WHERE task=? AND last_seen<? AND retired_at IS NULL').bind(stamp, task, stamp).run();
      await db.prepare("UPDATE ai_model_catalog_reads SET state='succeeded',read_at=?,models=? WHERE task=? AND attempted_at=?").bind(stamp, entries.length, task, stamp).run();
      refreshed++;
    } catch (error) {
      await db.prepare("UPDATE ai_model_catalog_reads SET state='failed',reason=? WHERE task=? AND attempted_at=?").bind(String(error?.message || 'Catalog read failed.').replace(/[A-Za-z0-9_-]{32,}/g, '[withheld]').slice(0, 200), task, stamp).run();
    } finally { clearTimeout(timer); }
  }
  return { refreshed };
}
async function catalog(db) {
  try {
    const [{ results: models }, { results: reads }] = await Promise.all([db.prepare('SELECT * FROM ai_model_catalog').all(), db.prepare('SELECT * FROM ai_model_catalog_reads').all()]);
    return { schema: true, models: new Map(models.map(row => [row.model, { ...row, properties: parse(row.properties) || {} }])), reads };
  } catch { return { schema: false, models: new Map(), reads: [] }; }
}
const truthy = value => value === true || value === 'true';
function price(value) {
  if (Array.isArray(value)) return value.filter(part => part && Number.isFinite(part.price)).map(part => `${part.currency === 'USD' ? '$' : ''}${part.price}${part.currency && part.currency !== 'USD' ? ' ' + part.currency : ''} ${part.unit}`.trim()).join(' · ');
  return typeof value === 'string' ? value : '';
}
// One option per deploy-listed model: offered only when the catalog lists it for the right task with the property the use needs.
function option(use, model, list, ceiling, env) {
  const def = aiUses[use], entry = list.models.get(model);
  const base = { model, description: entry?.description || '', price: price(entry?.properties?.price), contextWindow: String(entry?.properties?.context_window || ''), dimensions: ceiling.dimensions?.[model] || 0 };
  const read = list.reads.find(row => row.task === def.task && row.read_at);
  if (!entry) return { ...base, state: read ? 'not-listed' : 'unread', reason: read ? `Not in this account’s ${def.task} catalog.` : 'The catalog has not been read yet; refresh it to verify this model.' };
  if (entry.retired_at) return { ...base, state: 'retired', reason: `Retired from the catalog ${entry.retired_at.slice(0, 10)}.` };
  if (entry.task !== def.task) return { ...base, state: 'unsupported', reason: `Listed as ${entry.task}, not ${def.task}.` };
  if (def.needs && !Object.hasOwn(entry.properties, def.needs)) return { ...base, state: 'unverified', reason: `The catalog does not report ${def.needsLabel} for this model; capability unverified.` };
  if (def.needs && !truthy(entry.properties[def.needs])) return { ...base, state: 'unsupported', reason: `The catalog reports no ${def.needsLabel}.` };
  const expected = Number(env.SEARCH_DIMENSIONS) || 0;
  if (def.embedding && expected && base.dimensions && base.dimensions !== expected) return { ...base, state: 'dimension', reason: `Produces ${base.dimensions}-dimension vectors; the search index holds ${expected}. A new Vectorize index needs a deploy.` };
  return { ...base, state: 'available', reason: '' };
}
// Re-index cost when the embedding model changes. The search track keeps search_state; absent tables read as unknown.
async function reindex(db, model) {
  try {
    const row = await db.prepare('SELECT count(*) AS repositories,COALESCE(SUM(chunks),0) AS chunks FROM search_state WHERE model!=?').bind(model).first();
    return { known: true, repositories: row.repositories, chunks: row.chunks, calls: Math.ceil(row.chunks / 32) };
  } catch { return { known: false, repositories: 0, chunks: 0, calls: 0 }; }
}

const human = request => !request.headers.has('Authorization') && !request.headers.has('CF-Access-Client-Id') && !request.headers.has('CF-Access-Client-Secret') && Boolean(request.headers.get('X-Golf-Native-Access-Email'));
const editing = (env, schema) => !schema ? { enabled: false, reason: 'Apply the schema 35 migration to choose models. Deploy defaults apply.' }
  : locked(env) ? { enabled: false, reason: 'Installation policy is locked at deploy (policy_editing: false). Deploy defaults apply and every change needs a deploy.' }
  : { enabled: true, reason: 'Operations administrators signed in through Access choose within the deploy list. Allowing another model or letting repositories choose needs typed confirmation and an Access sign-in from the last 10 minutes.' };
const stale = () => { throw new Fault('failed_precondition', 412, 'This model setting changed since you read it. Refresh before editing.'); };

async function installationView(db, env) {
  const rows = await settingRows(db), list = await catalog(db), deploy = deployModels(env), retired = new Set([...list.models.values()].filter(row => row.retired_at).map(row => row.model));
  let overrides = new Map();
  try { overrides = new Map((await db.prepare("SELECT use,count(*) AS n FROM repository_ai_models m JOIN repositories r ON r.id=m.repository_id AND r.state='ACTIVE' WHERE m.model!='' GROUP BY use").all()).results.map(row => [row.use, row.n])); } catch {}
  const uses = [];
  for (const [use, def] of Object.entries(aiUses)) {
    if (def.fixed) { uses.push({ use, label: def.label, detail: def.detail, feature: def.feature, fixed: true, task: 'Constrained choice', value: { default: def.fixed, allowed: [def.fixed], repositoryOverride: false },
      reason: 'Clef is the only catalog model that returns calibrated probabilities for a constrained choice, so it is fixed here.' }); continue; }
    const row = rows?.get(settingKey(use)), setting = settingValue(env, use, row);
    if (!setting) { uses.push({ use, label: def.label, detail: def.detail, feature: def.feature, task: def.task, unavailable: deploy.valid ? 'This deploy lists no model for this use.' : 'The deploy model list (AI_MODELS) is not valid; nothing is allowed until it is redeployed.' }); continue; }
    const options = setting.ceiling.allowed.map(model => option(use, model, list, setting.ceiling, env));
    const others = [...list.models.values()].filter(entry => entry.task === def.task && !entry.retired_at && !setting.ceiling.allowed.includes(entry.model)).length;
    const notes = [];
    if (setting.unreadable) notes.push('The saved choice could not be read; the deploy value applies until it is saved again.');
    if (setting.narrowed) notes.push('The deploy list no longer includes part of the saved choice; only listed models apply.');
    for (const model of setting.value.allowed) if (retired.has(model)) notes.push(`${model} was retired from the catalog. ${model === setting.value.default ? 'New runs use the deploy default until you choose another default.' : 'Repositories that chose it fall back to the default.'} Recorded runs keep their model.`);
    uses.push({ use, label: def.label, detail: def.detail, feature: def.feature, task: def.task, needs: def.needsLabel || '', embedding: Boolean(def.embedding),
      value: setting.value, deploy: setting.deploy, source: setting.source, version: String(row?.version || 0), updatedAt: row?.updated_at || '', updatedBy: row?.updated_by || '',
      options, otherCatalogModels: others, repositoriesOverriding: setting.value.repositoryOverride ? overrides.get(use) || 0 : 0, notes, confirmation: settingKey(use),
      ...(def.embedding ? { reindex: await reindex(db, setting.value.default) } : {}) });
  }
  const reads = list.reads.map(row => ({ task: row.task, state: row.state, readAt: row.read_at || '', attemptedAt: row.attempted_at, models: row.models || 0, reason: row.reason || '' }));
  const tasks = [...new Set(configurable.map(use => aiUses[use].task))];
  return { generatedAt: time(), editing: editing(env, Boolean(rows) && list.schema), deploy: { source: deploy.source, valid: deploy.valid }, allocated: Boolean(env.AI && env.EVIDENCE_ALLOW_AI === 'true'),
    catalog: { reads, stale: list.schema && Boolean(env.AI?.models) && tasks.some(task => !(reads.find(row => row.task === task)?.readAt > new Date(Date.now() - catalogHours * 3600_000).toISOString())), refreshable: Boolean(env.AI?.models) },
    uses };
}

async function repositoryView(db, env, row, request) {
  const rows = await settingRows(db), list = await catalog(db);
  let choices = new Map();
  try { choices = new Map((await db.prepare('SELECT use,model,version FROM repository_ai_models WHERE repository_id=?').bind(row.id).all()).results.map(choice => [choice.use, choice])); } catch {}
  const uses = [];
  for (const [use, def] of Object.entries(aiUses)) {
    if (def.fixed) { uses.push({ use, label: def.label, feature: def.feature, fixed: true, model: def.fixed, source: 'fixed', note: '', overrideAllowed: false, allowed: [], choice: '', version: '0' }); continue; }
    const setting = settingValue(env, use, rows?.get(settingKey(use)));
    if (!setting) continue;
    let effective;
    try { effective = await aiModel(db, env, use, row.id); } catch (error) { if (!(error instanceof Fault)) throw error; effective = { model: '', source: 'unavailable', note: error.message }; }
    const choice = choices.get(use);
    uses.push({ use, label: def.label, feature: def.feature, model: effective.model, source: effective.source, note: effective.note, overrideAllowed: setting.value.repositoryOverride,
      default: setting.value.default, allowed: setting.value.allowed.filter(model => !list.models.get(model)?.retired_at).map(model => ({ model, description: list.models.get(model)?.description || '' })),
      choice: choice?.model || '', version: String(choice?.version || 0) });
  }
  return { repositoryId: String(row.id), canEdit: row.role === 'admin' && human(request) && !locked(env), allocated: Boolean(env.AI && env.EVIDENCE_ALLOW_AI === 'true'), uses };
}

// `/native/ai-models/read` { action: 'installation' | 'repository' } and `/native/ai-models` { action: 'refresh-catalog' | 'update' | 'repository-update' }.
export async function aiModelsAPI(db, env, person, request, body, read, repository) {
  const requireAdmin = async () => { if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.'); };
  if (read && body.action === 'repository') {
    const row = await repository();
    return reply(await repositoryView(db, env, row, request));
  }
  if (read && body.action === 'installation') {
    await requireAdmin();
    const view = await installationView(db, env);
    await requireAdmin();
    return reply(view);
  }
  if (read || !['refresh-catalog', 'update', 'repository-update'].includes(body.action)) invalid('Use installation or repository on the read route, and refresh-catalog, update or repository-update on the write route.');
  if (body.action === 'refresh-catalog') {
    await requireAdmin();
    try { await refreshCatalog(db, env, body.force === true); } catch { throw new Fault('failed_precondition', 412, 'Apply the schema 35 migration to keep a model catalog.'); }
    return reply(await installationView(db, env));
  }
  if (body.action === 'repository-update') return reply(await repositoryUpdate(db, env, person, request, body, await repository()));
  await requireAdmin();
  if (locked(env)) throw new Fault('failed_precondition', 412, editing(env, true).reason);
  const use = typeof body.use === 'string' && Object.hasOwn(aiUses, body.use) ? body.use : null, def = use && aiUses[use];
  if (!def) invalid('Choose an AI use case.');
  if (def.fixed) throw new Fault('failed_precondition', 412, `${def.label} always uses Clef; it cannot be changed.`);
  if (!uuidOK(body.operationId) || typeof body.expectedVersion !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(body.expectedVersion)) invalid('Provide an operation ID and the version you read.');
  const rows = await settingRows(db), list = await catalog(db);
  if (!rows || !list.schema) throw new Fault('failed_precondition', 412, 'Apply the schema 35 migration to choose models.');
  const key = settingKey(use), row = rows.get(key), setting = settingValue(env, use, row);
  if (!setting) throw new Fault('failed_precondition', 412, `${def.label}: this deploy lists no model; allowing one needs a deploy.`);
  const value = body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'allowed,default,repositoryOverride' || !Array.isArray(value.allowed) ||
      !value.allowed.length || value.allowed.length > maxAllowed || !value.allowed.every(modelOK) || new Set(value.allowed).size !== value.allowed.length || typeof value.repositoryOverride !== 'boolean')
    invalid('Choose one to 16 allowed models, a default among them and whether repositories may choose.');
  if (!value.allowed.includes(value.default)) invalid('The default must be one of the allowed models.');
  const before = setting.value;
  for (const model of value.allowed) {
    if (!setting.ceiling.allowed.includes(model)) invalid(`${model} is not on this installation’s deploy list; adding it needs a deploy.`);
    const offered = option(use, model, list, setting.ceiling, env);
    // Newly allowed models need a verified catalog entry; one already allowed may stay while it is not retired.
    if (offered.state !== 'available' && !(before.allowed.includes(model) && !['retired', 'not-listed', 'dimension'].includes(offered.state))) throw new Fault('failed_precondition', 412, `${model} cannot be allowed: ${offered.reason}`);
  }
  const after = { default: value.default, allowed: [...value.allowed], repositoryOverride: value.repositoryOverride };
  const inputHash = await digest(JSON.stringify([key, body.expectedVersion, after]));
  const previous = await db.prepare('SELECT * FROM installation_operations WHERE operation_id=?').bind(body.operationId).first();
  if (previous) {
    if (previous.actor_id !== person.id || previous.input_hash !== inputHash) throw new Fault('already_exists', 409, 'This operation ID belongs to another change.');
    return reply(JSON.parse(previous.receipt));
  }
  const version = Number(body.expectedVersion);
  if ((row?.version || 0) !== version) stale();
  if (JSON.stringify(after) === JSON.stringify(before)) invalid('Change the default, the allowed models or the repository choice before saving.');
  const widening = after.allowed.some(model => !before.allowed.includes(model)) || after.repositoryOverride && !before.repositoryOverride;
  if (widening) {
    if (body.confirmation !== key) throw new Fault('failed_precondition', 412, `This change widens the ${def.label.toLowerCase()} models. Type ${key} to confirm it.`);
    const issued = Number(request.headers.get('X-Golf-Native-Access-Issued-At'));
    if (!Number.isInteger(issued) || Date.now() / 1000 - issued > 600) throw new Fault('failed_precondition', 412, 'Widening changes need an Access sign-in from the last 10 minutes. Sign out of Access, sign in again and retry.');
  }
  const stamp = time(), text = JSON.stringify(after), email = request.headers.get('X-Golf-Native-Access-Email');
  const admin = 'EXISTS(SELECT 1 FROM operations_admins a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.active=1 AND u.active=1 AND u.email=?)';
  const receipt = { key, use, version: String(version + 1), value: after, widening, operationId: body.operationId, at: stamp,
    ...(use === 'agents' && after.default !== before.default ? { effect: 'Queued and running agent proposals admitted with the previous model are refused at their next step.' } : {}),
    ...(def.embedding && after.default !== before.default ? { effect: 'Every repository’s search index is re-built with the new model; the old index serves until it completes.' } : {}) };
  await db.batch([
    version ? db.prepare(`UPDATE installation_settings SET value=?,version=version+1,updated_by=?,updated_at=? WHERE key=? AND version=? AND ${admin}`).bind(text, person.id, stamp, key, version, person.id, email)
      : db.prepare(`INSERT INTO installation_settings(key,value,version,updated_by,updated_at) SELECT ?,?,1,?,? WHERE ${admin} ON CONFLICT(key) DO NOTHING`).bind(key, text, person.id, stamp, person.id, email),
    auditStatement(db, { actor: person, actorEmail: email, scope: 'installation', scopeId: env.WORKSPACE_SLUG, subject: key, action: 'ai_model.update', before, after, widening, operationId: body.operationId, client: clientHeaders(request) }),
    db.prepare('INSERT INTO installation_operations(operation_id,actor_id,input_hash,receipt,created_at) SELECT ?,?,?,?,? WHERE changes()=1').bind(body.operationId, person.id, inputHash, JSON.stringify(receipt), stamp),
  ]);
  if (!await db.prepare('SELECT 1 AS saved FROM installation_operations WHERE operation_id=?').bind(body.operationId).first()) { await requireAdmin(); stale(); }
  return reply(receipt);
}

// A repository administrator under a verified Access sign-in picks one of the allowed models, or '' to follow the installation default.
async function repositoryUpdate(db, env, person, request, body, row) {
  if (!human(request) || row.role !== 'admin') throw new Fault('permission_denied', 403, 'Repository models change only under a verified Access sign-in by a current repository administrator.');
  if (locked(env)) throw new Fault('failed_precondition', 412, 'Installation policy is locked at deploy (policy_editing: false); repository model choices cannot change.');
  if (Object.keys(body).some(key => !['action', 'repository', 'repositoryId', 'use', 'model', 'expectedVersion'].includes(key)) || body.repositoryId !== String(row.id) ||
      typeof body.expectedVersion !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(body.expectedVersion) || typeof body.model !== 'string' || body.model && !modelOK(body.model))
    invalid('Name the use case, a model or an empty value for the installation default, the repository ID and the version you read.');
  const use = Object.hasOwn(aiUses, body.use) ? body.use : null, def = use && aiUses[use];
  if (!def) invalid('Choose an AI use case.');
  if (def.fixed) throw new Fault('failed_precondition', 412, `${def.label} always uses Clef.`);
  const setting = settingValue(env, use, (await settingRows(db))?.get(settingKey(use)));
  if (!setting?.value.repositoryOverride) throw new Fault('failed_precondition', 412, `The installation does not let repositories choose the ${def.label.toLowerCase()} model.`);
  if (body.model && (!setting.value.allowed.includes(body.model) || (await retiredModels(db)).has(body.model))) throw new Fault('failed_precondition', 412, `${body.model} is not allowed for ${def.label.toLowerCase()} on this installation.`);
  let current;
  try { current = await db.prepare('SELECT model,version FROM repository_ai_models WHERE repository_id=? AND use=?').bind(row.id, use).first(); }
  catch { throw new Fault('failed_precondition', 412, 'Apply the schema 35 migration to choose repository models.'); }
  const version = Number(body.expectedVersion);
  if ((current?.version || 0) !== version) throw new Fault('failed_precondition', 412, 'This repository’s model choice changed since you read it. Refresh before editing.');
  if ((current?.model || '') === body.model) invalid('Choose a different model before saving.');
  const authority = settingsAuthority(person, row), stamp = time(), email = request.headers.get('X-Golf-Native-Access-Email');
  const saved = await db.batch([
    db.prepare(`INSERT INTO repository_ai_models(repository_id,use,model,version,updated_by,updated_at) SELECT ?,?,?,?,?,? WHERE ${authority.sql}
      ON CONFLICT(repository_id,use) DO UPDATE SET model=excluded.model,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE repository_ai_models.version=?`)
      .bind(row.id, use, body.model, version + 1, person.id, stamp, ...authority.values, version),
    auditStatement(db, { actor: person, actorEmail: email, scope: 'repository', scopeId: String(row.id), subject: settingKey(use), action: 'repository_ai_model.update', before: current?.model || null, after: body.model || null, widening: false, client: clientHeaders(request) }),
  ]);
  if (saved[0].meta.changes !== 1) throw new Fault('failed_precondition', 412, 'This repository’s model choice, or your access, changed. Refresh before editing.');
  return repositoryView(db, env, row, request);
}
