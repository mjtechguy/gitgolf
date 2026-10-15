// Rate budgets for agents (AM-6, docs/AGENT_ACCESS.md): requests and writes per minute for each API token (golf_pat_) and each
// agent-host task token. The counters live in the Workspace Durable Object's memory (env.agentBudgets), which every token
// request already passes through, so counting needs no binding and no D1 write. They are a throttle, not a quota: a restart
// of the Workspace (a deploy, eviction) starts every window afresh, and under memory pressure the least recently used key is
// forgotten first. Signed-in people are never counted; only the callers that core.mjs and agent-host-protocol.mjs charge.
//
// Each key has a fixed one-minute window that opens with its first request. A request is admitted while the window holds fewer
// requests than the budget; a write (a push, a Source API commit or branch change, an MCP write tool) also needs the write
// budget. A refused request counts against nothing, and Retry-After is the time until the window closes.

import { invalid } from './common.mjs';

const windowMs = 60_000, idleMs = 120_000, keyCap = 10_000, policyTTL = 60_000;
const limitBounds = [1, 100_000];
export const budgetDefaults = Object.freeze({ enabled: true, tokenRequestsPerMinute: 600, tokenWritesPerMinute: 60, taskRequestsPerMinute: 600, taskWritesPerMinute: 120 });
const limitKeys = ['tokenRequestsPerMinute', 'tokenWritesPerMinute', 'taskRequestsPerMinute', 'taskWritesPerMinute'];
const who = { token: 'API token', task: 'Agent task' };

export class AgentBudgets {
  constructor({ now = () => Date.now(), cap = keyCap } = {}) {
    this.now = now; this.cap = cap;
    // Map order is least recently used first: a touched key is moved to the end.
    this.entries = new Map();
    this.cached = null; this.loading = null;
  }
  // Keys untouched for two minutes hold nothing a window still needs.
  sweep(now) {
    for (const [key, entry] of this.entries) {
      if (now - entry.seen < idleMs) break;
      this.entries.delete(key);
    }
  }
  // limits: { requests, writes } to enforce, or null to count without refusing (budgets off).
  charge(kind, id, write, limits) {
    const now = this.now(), key = kind + ':' + id;
    this.sweep(now);
    let entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    if (!entry || now - entry.start >= windowMs) entry = { start: now, requests: 0, writes: 0, seen: now };
    entry.seen = now;
    while (this.entries.size >= this.cap) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, entry);
    if (limits) {
      const budget = entry.requests >= limits.requests ? 'requests' : write && entry.writes >= limits.writes ? 'writes' : null;
      if (budget) return refusal(kind, budget, limits[budget], Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)));
    }
    entry.requests++;
    if (write) entry.writes++;
    return null;
  }
  // What the current window holds for a key; an expired or forgotten window holds nothing.
  usage(kind, id) {
    const now = this.now(), entry = this.entries.get(kind + ':' + id);
    if (!entry || now - entry.start >= windowMs) return { requests: 0, writes: 0, resetsInSeconds: 0 };
    return { requests: entry.requests, writes: entry.writes, resetsInSeconds: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) };
  }
  get size() { return this.entries.size; }
  // The installation policy, read at most once a minute; an installation update in this Workspace drops it at once.
  async policy(load) {
    const now = this.now();
    if (this.cached && now - this.cached.at < this.cached.ttl) return this.cached.value;
    this.loading ||= load().then(({ value, ttl = policyTTL }) => { this.cached = { at: this.now(), value, ttl }; return value; }).finally(() => { this.loading = null; });
    return this.loading;
  }
  invalidate() { this.cached = null; }
}

function refusal(kind, budget, limit, retryAfter) {
  const unit = budget === 'writes' ? 'writes' : 'requests';
  return { kind, budget, limit, retryAfter,
    message: `${who[kind]} budget: ${limit} ${unit} per minute reached; retry in ${retryAfter} s.`,
    // Git's own report: "! [remote rejected] <ref> (budget: …)".
    reason: `budget: ${limit} ${unit} per minute for this ${who[kind].toLowerCase()} reached; retry in ${retryAfter} s` };
}

// ---------- installation policy 'agent-budgets' (installation.mjs installationPolicies) ----------
const int = value => Number.isInteger(value) && value >= limitBounds[0] && value <= limitBounds[1];
const shaped = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 5 && typeof value.enabled === 'boolean' && limitKeys.every(key => int(value[key]));
const canonical = value => ({ enabled: value.enabled, ...Object.fromEntries(limitKeys.map(key => [key, value[key]])) });
// Not a deploy allocation: the built-in defaults apply until an operations administrator changes them, and any value in bounds may be set.
export const agentBudgetsPolicy = {
  label: 'Agent rate budgets', deploy: () => ({ ...budgetDefaults }),
  bounds: () => Object.fromEntries(limitKeys.map(key => [key, [...limitBounds]])),
  validate(env, value) {
    if (!shaped(value)) invalid(`Choose on or off and four whole numbers from ${limitBounds[0]} to ${limitBounds[1].toLocaleString('en-US')} a minute.`);
    return canonical(value);
  },
  effective(env, value) { if (!shaped(value)) throw Error('unreadable'); return canonical(value); },
  // Turning budgets off or raising any limit loosens the throttle.
  widening: (before, after) => before.enabled && !after.enabled || limitKeys.some(key => after[key] > before[key]),
  overlay: value => ({ AGENT_BUDGETS: JSON.stringify(value) }),
  effect: { queued: 'Nothing is queued by a budget.', inFlight: 'Requests already admitted complete.',
    new: 'Applies to the next request: each token and task keeps the window it has open, counted against the new limits.' } };
// The value the installation overview shows (installationGroups reads the overlay).
export function budgetOverlayValue(env) {
  try { return agentBudgetsPolicy.effective(env, JSON.parse(env.AGENT_BUDGETS)); } catch { return { ...budgetDefaults }; }
}

// The effective policy for this Workspace: one indexed D1 read a minute at most, never one per request. The same rules as
// installation.mjs current(): a locked installation, no schema 30 table or an unreadable row all mean the defaults.
export async function budgetPolicy(env, db) {
  const budgets = env.agentBudgets;
  if (!budgets) return null;
  return budgets.policy(async () => {
    if (env.INSTALLATION_POLICY_EDITING === 'false') return { value: { ...budgetDefaults } };
    let row;
    // A failed read (or no installation_settings table) uses the defaults and asks again sooner.
    try { row = await db.prepare("SELECT value FROM installation_settings WHERE key='agent-budgets'").first(); } catch { return { value: { ...budgetDefaults }, ttl: 10_000 }; }
    try { return { value: row ? agentBudgetsPolicy.effective(env, JSON.parse(row.value)) : { ...budgetDefaults } }; } catch { return { value: { ...budgetDefaults } }; }
  });
}
export const budgetLimits = (policy, kind) => policy && { requests: policy[kind + 'RequestsPerMinute'], writes: policy[kind + 'WritesPerMinute'] };

// Count one request for a token or task; returns null when admitted, or the refusal. Without a counter (a runtime other than the
// Workspace) nothing is counted or refused.
export async function chargeBudget(env, db, kind, id, write) {
  // The stateless Worker (scale-out S1, docs/SCALE_OUT_PLAN.md) has no counters: the Workspace charges its own, under its cached policy.
  if (env.workspaceBudget) return env.workspaceBudget(kind, String(id), Boolean(write));
  const budgets = env.agentBudgets;
  if (!budgets) return null;
  const policy = await budgetPolicy(env, db);
  const refused = budgets.charge(kind, String(id), Boolean(write), policy.enabled ? budgetLimits(policy, kind) : null);
  if (refused) console.log(JSON.stringify({ event: 'golf.agent_budget_refused', kind, budget: refused.budget, limit: refused.limit }));
  return refused;
}

const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
// /native/source and the task JSON routes.
export const budgetJSON = refused => Response.json({ code: 'resource_exhausted', message: refused.message, retryAfter: refused.retryAfter },
  { status: 429, headers: { ...noStore, 'Retry-After': String(refused.retryAfter) } });
// Git fetches and advertisements: Git prints a text/plain error body as "remote: …".
export const budgetText = refused => new Response(refused.message + '\n', { status: 429, headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(refused.retryAfter) } });
