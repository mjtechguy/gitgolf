import { invalid } from './common.mjs';
import { pipelinePolicy } from './pipeline-policy.mjs';

/* Runner capacity policy (docs/SCALE_OUT_PLAN.md S5, docs/RUNNER_CAPACITY.md), slice 2. A leaf module: installation.mjs lists these two
 * installation policies, and capacity-shares.mjs enforces them in the claim, so neither imports the other through here.
 *
 * runner-pools: a concurrency cap per self-hosted pool. A pool is slice 1's: an engine plus the sorted set of runner label names (a Forgejo
 *   label "name:docker://image" is "name"). Self-hosted machines have no deploy allocation, so the deploy value is "no caps".
 * runner-shares: the installation's share of runner capacity for each organization (all its repositories together) and each personal
 *   repository: running pipeline jobs, and pipeline runs started per UTC day. null is no limit. Organizations and repositories may set a
 *   value at or below it (capacity_shares, schema 52) unless the installation enforces it. */

export const engines = ['forgejo-actions', 'gitlab-ci'];
export const labelName = label => String(label).split(':')[0];
export const poolLabels = labels => [...new Set((Array.isArray(labels) ? labels : []).map(labelName))].sort();
export const poolId = (engine, labels) => `${engine}:${labels.join(',')}`;

export const capBounds = [1, 1000], poolLimit = 100;
export const shareFields = ['maxRunning', 'maxRunsPerDay'];
export const shareBounds = { maxRunning: [1, 1000], maxRunsPerDay: [1, 100000] };
export const shareLabels = { maxRunning: 'Concurrent pipeline jobs', maxRunsPerDay: 'Pipeline runs a day' };
// capacity_shares columns for each field: the scope's own value, and (organizations only) the installation's grant from an approved request.
export const shareColumns = { maxRunning: ['max_running', 'granted_running'], maxRunsPerDay: ['max_runs_per_day', 'granted_runs_per_day'] };

const int = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function caps(value) {
  if (!plain(value) || Object.keys(value).length !== 1 || !Array.isArray(value.pools) || value.pools.length > poolLimit) invalid(`List at most ${poolLimit} pool caps.`);
  const seen = new Set();
  const pools = value.pools.map(pool => {
    if (!plain(pool) || Object.keys(pool).some(key => !['engine', 'labels', 'maxConcurrent'].includes(key)) || !engines.includes(pool.engine) || !Array.isArray(pool.labels) || pool.labels.length > 32 ||
        pool.labels.some(label => typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(labelName(label))))
      invalid('Each pool cap names an engine (forgejo-actions or gitlab-ci) and up to 32 runner label names.');
    if (!int(pool.maxConcurrent, capBounds)) invalid(`A pool cap is a whole number of running jobs from ${capBounds[0]} to ${capBounds[1]}.`);
    const labels = poolLabels(pool.labels), id = poolId(pool.engine, labels);
    if (seen.has(id)) invalid(`The pool ${id} has two caps.`);
    seen.add(id);
    return { engine: pool.engine, labels, maxConcurrent: pool.maxConcurrent };
  });
  return { pools: pools.sort((a, b) => poolId(a.engine, a.labels).localeCompare(poolId(b.engine, b.labels))) };
}
export const capFor = (value, engine, labels) => value?.pools.find(pool => poolId(pool.engine, pool.labels) === poolId(engine, poolLabels(labels)))?.maxConcurrent ?? null;

export const runnerPoolsPolicy = { label: 'Runner pool caps', deploy: env => pipelinePolicy(env) ? { pools: [] } : null,
  bounds: () => ({ maxConcurrent: capBounds, pools: [0, poolLimit] }),
  validate: (env, value) => caps(value), effective: (env, value) => caps(value),
  // Removing a cap, or raising one, lets more jobs start: typed confirmation and a recent sign-in. A new cap only narrows.
  widening: (before, after) => before.pools.some(pool => { const next = after.pools.find(item => poolId(item.engine, item.labels) === poolId(pool.engine, pool.labels)); return !next || next.maxConcurrent > pool.maxConcurrent; }),
  // Read where it applies (pipelines.mjs claimPipelineJob), not through the environment.
  overlay: () => ({}),
  effect: { queued: 'Queued jobs stay queued while their pool is at its cap; nothing is cancelled.', inFlight: 'Running jobs are not stopped; a lower cap applies as they finish.',
    new: 'A runner in a capped pool gets no job while the pool has that many running, exactly as when the queue is empty.' } };

function shares(value) {
  if (!plain(value) || Object.keys(value).length !== 3 || ![...shareFields, 'enforced'].every(key => Object.hasOwn(value, key)) || typeof value.enforced !== 'boolean') invalid('Set concurrent jobs, runs a day (each empty for no limit) and whether the installation enforces them.');
  for (const field of shareFields) if (value[field] !== null && !int(value[field], shareBounds[field])) invalid(`${shareLabels[field]} is empty (no limit) or a whole number from ${shareBounds[field][0]} to ${shareBounds[field][1]}.`);
  return { maxRunning: value.maxRunning, maxRunsPerDay: value.maxRunsPerDay, enforced: value.enforced };
}
export const wider = (before, after) => before !== null && (after === null || after > before);
export const runnerSharesPolicy = { label: 'Runner shares', deploy: env => pipelinePolicy(env) ? { maxRunning: null, maxRunsPerDay: null, enforced: false } : null,
  bounds: () => ({ ...shareBounds }),
  validate: (env, value) => shares(value), effective: (env, value) => shares(value),
  // Enforcing replaces organizations' and repositories' narrower values with the installation's, so it widens too.
  widening: (before, after) => shareFields.some(field => wider(before[field], after[field])) || !before.enforced && after.enforced,
  overlay: () => ({}),
  effect: { queued: 'Jobs over a share stay queued; runners take other eligible jobs meanwhile. Nothing is cancelled.', inFlight: 'Running jobs are not stopped; a lower share applies as they finish.',
    new: 'The next claim and the next run counts against the new share. A run over its daily share is recorded as refused, with the reason.' } };

/* The limits that apply to one repository. installation: the runner-shares value; organization and repository: capacity_shares rows or
 * null; inOrganization: the repository belongs to an organization. Each field: null is no limit.
 * - organization ceiling: the installation value, or the installation's higher grant for this organization (an approved request);
 * - organization limit: its own value at or below the ceiling, unless the installation enforces its value;
 * - repository ceiling: the organization's limit, or the installation value for a personal repository;
 * - repository limit: its own value at or below that, unless enforced. Values saved above a later, lower ceiling are narrowed here. */
export const tighter = (a, b) => a === null || a === undefined ? b ?? null : b === null || b === undefined ? a : Math.min(a, b);
export function shareLimits(installation, organization, repository, inOrganization) {
  const result = { organization: inOrganization ? { ceiling: {}, limit: {} } : null, repository: { ceiling: {}, limit: {} } };
  for (const field of shareFields) {
    const [own, granted] = shareColumns[field], base = installation?.[field] ?? null, enforced = Boolean(installation?.enforced);
    if (inOrganization) {
      // A grant only ever raises: once the installation value reaches it, the installation value applies; with no installation limit there is none.
      const ceiling = base === null ? null : Math.max(organization?.[granted] ?? base, base);
      result.organization.ceiling[field] = ceiling;
      result.organization.limit[field] = enforced ? ceiling : tighter(organization?.[own], ceiling);
    }
    const ceiling = inOrganization ? result.organization.limit[field] : base;
    result.repository.ceiling[field] = ceiling;
    result.repository.limit[field] = enforced ? ceiling : tighter(repository?.[own], ceiling);
  }
  return result;
}
