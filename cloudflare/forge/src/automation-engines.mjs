// Engines for automations (docs/AUTOMATIONS.md). A thin adapter over the engines registry (engines.mjs, agents plan phase 2), whose
// interface is listEngines(db, env, person, scope), resolveEngine(db, env, { person, repository, useCase, engine }) and
// runChat(env, handle, messages, options) → { text, usage }. Until that registry is part of this Worker, `default` is the only model
// engine: it runs the installation's model selection through the existing Workers AI runs (ai-workflow.mjs: quotas, the private
// gateway, usage). Coding CLIs are not engines of the registry here: they run on an agent host as an agent task (agent-hosts.mjs).
//
// The registry (engines.mjs, #115) is registered at the end of this file; tests can register a stand-in through useEngines.
import { agentTools } from './agent-hosts.mjs';
import * as engines from './engines.mjs';

let registry = null;
export function useEngines(module) {
  registry = module && typeof module.listEngines === 'function' && typeof module.resolveEngine === 'function' && typeof module.runChat === 'function' ? module : null;
}
export const enginesRegistered = () => Boolean(registry);

export const defaultEngine = { id: 'default', kind: 'model', label: 'Installation model selection (Workers AI)',
  detail: 'Runs the model chosen for this use in AI model selection, through Workers AI runs and the private AI Gateway.' };
const cliLabels = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', grok: 'Grok' };
export const cliEngines = agentTools.map(id => ({ id, kind: 'cli', label: cliLabels[id] || id, detail: 'A coding CLI on an agent host you choose.' }));
export const isCLI = engine => agentTools.includes(engine);

// The engines a person may choose for one scope: the model selection, the registry's engines (when registered) and the coding CLIs.
export async function automationEngines(db, env, person, scope) {
  const listed = [];
  if (registry) {
    try {
      // The registry's scopes: a repository row, an organization id, or the installation.
      const registryScope = scope?.scope === 'organization' ? { organizationId: String(scope.scopeId) }
        : scope?.scope === 'repository' ? { repository: await db.prepare('SELECT * FROM repositories WHERE id=?').bind(Number(scope.scopeId)).first() } : {};
      for (const engine of await registry.listEngines(db, env, person, registryScope) || []) {
        const id = String(engine?.id || '');
        if (!/^[A-Za-z0-9._:/@-]{1,100}$/.test(id) || id === 'default' || isCLI(id) || engine.usable === false) continue;
        listed.push({ id, kind: 'model', label: String(engine.label || id).slice(0, 100), detail: String(engine.detail || engine.description || '').slice(0, 300) });
      }
    } catch { /* the registry answers nothing: the model selection and the CLIs stay available */ }
  }
  return [defaultEngine, ...listed, ...cliEngines];
}
// A saved engine: the default, a CLI, or an id the registry lists for this scope. Without the registry only the first two exist.
export async function engineAllowed(db, env, person, scope, engine) {
  if (engine === 'default' || isCLI(engine)) return true;
  if (!registry) return false;
  return (await automationEngines(db, env, person, scope)).some(item => item.id === engine);
}

// Engine inference outside the workspace queue: one chat with the registry's engine. Returns { text, usage } or throws.
export async function engineChat(db, env, { person, repository, useCase, engine }, messages, options = {}) {
  if (!registry) throw Error('The engines registry is not part of this installation.');
  const handle = await registry.resolveEngine(db, env, { person, repository, useCase, engineId: engine });
  if (!handle) throw Error(`Engine ${engine} is not available for this repository.`);
  const answer = await registry.runChat(env, handle, messages, options);
  if (typeof answer?.text !== 'string') throw Error('The engine returned no text.');
  if (answer.finishReason === 'length') throw Error('The model’s answer was cut off at its token limit.');
  return { text: answer.text, usage: usageOf(answer.usage) };
}
// Token counts exactly as reported; anything malformed is dropped rather than guessed.
export function usageOf(value) {
  const usage = {};
  const pick = (key, ...names) => { for (const name of names) if (Number.isSafeInteger(value?.[name]) && value[name] >= 0) { usage[key] = value[name]; return; } };
  pick('inputTokens', 'inputTokens', 'input_tokens', 'prompt_tokens');
  pick('outputTokens', 'outputTokens', 'output_tokens', 'completion_tokens');
  if (typeof value?.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0) usage.costUsd = value.costUsd;
  return Object.keys(usage).length ? { ...usage, reported: true } : {};
}

useEngines(engines);
