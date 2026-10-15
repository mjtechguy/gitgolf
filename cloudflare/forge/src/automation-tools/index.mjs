// The built-in automation library (docs/AUTOMATIONS.md, agents plan phase 2): the first four tools and custom automations.
// A tool is { id, label, description, engines ('model' | 'cli' | 'any'), schedule, events, outputs, targets, defaults, dedupe(event),
// start(ctx), apply(ctx, result), and for model engines engineRequest(input) / engineParse(text, input); scheduled(ctx) when it runs on
// a schedule }. automations.mjs owns every effect; a tool decides what to read and what to write through ctx.
import { prReviewer } from './pr-reviewer.mjs';
import { issueTriage } from './issue-triage.mjs';
import { issueToPR } from './issue-to-pr.mjs';
import { ciFixer } from './ci-fixer.mjs';
import { custom } from './custom.mjs';

export const automationTools = Object.freeze({ 'pr-reviewer': prReviewer, 'issue-triage': issueTriage, 'issue-to-pr': issueToPR, 'ci-fixer': ciFixer, custom });
export const toolIds = Object.keys(automationTools);
// What the settings UI shows for each tool, never the functions.
export const toolCatalogue = () => Object.values(automationTools).map(tool => ({ id: tool.id, label: tool.label, description: tool.description, engines: tool.engines,
  schedule: tool.schedule, events: [...tool.events], outputs: [...tool.outputs], ...(tool.cliOutputs ? { cliOutputs: [...tool.cliOutputs] } : {}), opensPullRequests: Boolean(tool.opensPullRequests),
  defaults: { name: tool.defaults.name, events: [...tool.defaults.events], output: [...tool.defaults.output], limits: { ...tool.defaults.limits }, instructions: tool.defaults.instructions } }));
