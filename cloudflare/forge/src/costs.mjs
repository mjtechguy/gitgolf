import { Fault, reply, invalid } from './common.mjs';
import { bounded } from './git.mjs';
import { operationsAdmin } from './operations.mjs';

// Estimated costs for operations administrators (docs/SCALE_OUT_PLAN.md S6). Every figure here is an estimate from list prices, not a
// bill: usage comes from Cloudflare's GraphQL Analytics API with the read-only analytics token, counts from Golf's own D1 records.
// A service whose usage cannot be read is reported as not readable, never as zero.
const day = 86400_000;
export const pricesAsOf = '2026-10-15';
export const daysPerMonth = 30.4;
const docs = 'https://developers.cloudflare.com/';
export const pricingPages = {
  workers: docs + 'workers/platform/pricing/', do: docs + 'durable-objects/platform/pricing/', d1: docs + 'd1/platform/pricing/', r2: docs + 'r2/pricing/',
  queues: docs + 'queues/platform/pricing/', artifacts: docs + 'artifacts/platform/pricing/', containers: docs + 'containers/pricing/',
  ai: docs + 'workers-ai/platform/pricing/', vectorize: docs + 'vectorize/platform/pricing/',
};

// Workers Paid list prices and included monthly allowances, reviewed against the pages above on pricesAsOf. `price` is USD per `per`
// units above `included`. Storage rates are per GB-month (1 GB = 10^9 bytes). Allowances are per account, shared with anything else on it.
const rate = (id, service, label, unit, price, per, included, extra = {}) => ({ id, service, label, unit, price, per, included, source: pricingPages[service], asOf: pricesAsOf, ...extra });
export const rates = [
  rate('workers.subscription', 'workers', 'Workers Paid subscription', 'month', 5, 1, 0, { fixed: true }),
  rate('workers.requests', 'workers', 'Requests', 'requests', 0.30, 1e6, 10e6),
  rate('workers.cpu', 'workers', 'CPU time', 'CPU ms', 0.02, 1e6, 30e6),
  rate('do.requests', 'do', 'Requests', 'requests', 0.15, 1e6, 1e6),
  rate('do.duration', 'do', 'Duration (active time × 128 MB)', 'GB-s', 12.50, 1e6, 400_000),
  rate('do.rows-read', 'do', 'SQLite rows read', 'rows', 0.001, 1e6, 25e9),
  rate('do.rows-written', 'do', 'SQLite rows written', 'rows', 1.00, 1e6, 50e6),
  rate('do.storage', 'do', 'SQLite stored data', 'GB-month', 0.20, 1, 5, { storage: true }),
  rate('d1.rows-read', 'd1', 'Rows read', 'rows', 0.001, 1e6, 25e9),
  rate('d1.rows-written', 'd1', 'Rows written', 'rows', 1.00, 1e6, 50e6),
  rate('d1.storage', 'd1', 'Storage', 'GB-month', 0.75, 1, 5, { storage: true }),
  rate('r2.class-a', 'r2', 'Class A operations', 'operations', 4.50, 1e6, 1e6),
  rate('r2.class-b', 'r2', 'Class B operations', 'operations', 0.36, 1e6, 10e6),
  rate('r2.storage', 'r2', 'Standard storage', 'GB-month', 0.015, 1, 10, { storage: true }),
  rate('queues.operations', 'queues', 'Standard operations', 'operations', 0.40, 1e6, 1e6),
  // "Cloudflare will begin billing for Artifacts operations and storage on October 14, 2026."
  rate('artifacts.operations', 'artifacts', 'Operations', 'operations', 0.15, 1000, 10_000, { billedFrom: '2026-10-14' }),
  rate('artifacts.storage', 'artifacts', 'Storage', 'GB-month', 0.50, 1, 1, { storage: true, billedFrom: '2026-10-14' }),
  rate('containers.memory', 'containers', 'Memory', 'GiB-s', 0.0000025, 1, 25 * 3600),
  rate('containers.cpu', 'containers', 'CPU (active use)', 'vCPU-s', 0.000020, 1, 375 * 60),
  rate('containers.disk', 'containers', 'Disk', 'GB-s', 0.00000007, 1, 200 * 3600),
  rate('ai.neurons', 'ai', 'Neurons', 'neurons', 0.011, 1000, 10_000, { includedPer: 'day' }),
  rate('vectorize.queried', 'vectorize', 'Queried vector dimensions', 'dimensions', 0.01, 1e6, 50e6),
  rate('vectorize.stored', 'vectorize', 'Stored vector dimensions', 'dimensions', 0.05, 1e8, 10e6),
];
const rateById = new Map(rates.map(item => [item.id, item]));
export const serviceLabels = { workers: 'Workers', do: 'Durable Objects', d1: 'D1', r2: 'R2', queues: 'Queues', artifacts: 'Artifacts', containers: 'Containers', ai: 'Workers AI', vectorize: 'Vectorize', runners: 'Self-hosted runners' };

// ----- Price math: one place, used by both the running-now read and the what-if estimate. -----
const round = (value, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
export const billable = (item, usage) => Math.max(0, usage - item.included);
export const priced = (item, usage) => round(billable(item, usage) / item.per * item.price);

// The calendar month in UTC containing `now`, and how much of it has passed.
export function monthPeriod(now) {
  const date = new Date(now), start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), now: new Date(now).toISOString(), days: (end - start) / day, elapsedDays: (now - start) / day };
}

// One rate against month-to-date usage: included, billable and cost so far, and the full month projected at the pace so far.
// Storage is a level, not a running total: the current size is assumed for the whole month and accrues with the days passed.
export function runningLine(item, observed, period) {
  const head = { rate: item.id, label: item.label, unit: item.unit, included: item.included, price: item.price, per: item.per, source: item.source };
  if (!observed || observed.state !== 'observed') return { ...head, state: observed?.state || 'unreadable', reason: observed?.reason || 'Usage for this rate is not read.' };
  const start = Math.max(Date.parse(period.start), item.billedFrom ? Date.parse(item.billedFrom + 'T00:00:00Z') : 0), end = Date.parse(period.end), now = Date.parse(period.now);
  if (start >= end) return { ...head, state: 'not-billed', reason: `Cloudflare bills this from ${item.billedFrom}.` };
  if (start > now) return { ...head, state: 'not-billed', reason: `Cloudflare bills this from ${item.billedFrom}; nothing is billable yet.` };
  const billedDays = (end - start) / day, elapsed = (now - start) / day, monthDays = period.days;
  const note = [observed.note, item.billedFrom && start > Date.parse(period.start) ? `Billed from ${item.billedFrom}; earlier use this month is not counted.` : '', elapsed < 1 ? 'Less than a day of data: the projection is rough.' : ''].filter(Boolean).join(' ');
  if (item.storage) {
    const full = priced(item, observed.value);
    return { ...head, state: 'observed', storage: true, monthToDate: round(observed.value), projected: round(observed.value), billableProjected: round(billable(item, observed.value)),
      costMonthToDate: round(full * elapsed / monthDays), costProjected: round(full * billedDays / monthDays), note };
  }
  const projected = elapsed > 0 ? observed.value * billedDays / elapsed : observed.value;
  return { ...head, state: 'observed', monthToDate: round(observed.value), billableMonthToDate: round(billable(item, observed.value)), costMonthToDate: priced(item, observed.value),
    projected: round(projected), billableProjected: round(billable(item, projected)), costProjected: priced(item, projected), note };
}

// A service total only adds lines that were read; anything else is named as missing, never counted as zero.
export function serviceTotal(lines) {
  const counted = lines.filter(line => line.state === 'observed'), missing = lines.filter(line => !['observed', 'not-billed'].includes(line.state)).map(line => line.label);
  if (!counted.length) return { state: lines.length && lines.every(line => line.state === 'not-billed') ? 'not-billed' : 'unreadable', missing };
  return { state: missing.length ? 'partial' : 'observed', missing, costMonthToDate: round(counted.reduce((sum, line) => sum + line.costMonthToDate, 0)),
    costProjected: round(counted.reduce((sum, line) => sum + line.costProjected, 0)) };
}

// Usage per unit of Golf activity in a measured window: per applied write and per landed pull request (each all-in: the reads, page
// views, landings and CI coordination that went with them are included), and per CI run for the storage and queue traffic CI drives.
// A ratio is null when the usage was not read or the count is zero or unknown.
export const activityRates = ['workers.requests', 'workers.cpu', 'do.requests', 'do.duration', 'd1.rows-read', 'd1.rows-written', 'artifacts.operations'];
export const ciRates = ['r2.class-a', 'r2.class-b', 'queues.operations'];
export const storageRates = ['d1.storage', 'r2.storage'];
export function measuredUnits(usage, counts) {
  const per = (value, count) => typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(count) && count > 0 ? round(value / count, 9) : null;
  return [
    ...activityRates.map(id => ({ rate: id, driver: 'activity', window: usage[id] ?? null, perWrite: per(usage[id], counts.writes), perLand: per(usage[id], counts.landed), perCiRun: null })),
    ...ciRates.map(id => ({ rate: id, driver: 'ci', window: usage[id] ?? null, perWrite: null, perLand: null, perCiRun: per(usage[id], counts.ciRuns) })),
    ...storageRates.map(id => ({ rate: id, driver: 'fixed', window: usage[id] ?? null, current: typeof usage[id] === 'number' ? round(usage[id], 9) : null })),
  ].map(unit => ({ ...unit, label: `${serviceLabels[rateById.get(unit.rate).service]}: ${rateById.get(unit.rate).label}`, unit: rateById.get(unit.rate).unit }));
}

// Starting values for the what-if form, from the ~110-agent benchmark (docs/benchmarks/2026-10-15-scale-out): about 0.5 applied writes
// per agent per minute. Every value is an assumption the administrator edits.
export const defaultScenario = { agents: 100, writesPerAgentPerMinute: 0.5, activeHoursPerDay: 8, prsLandedPerDay: 300, ciRunsPerDay: 300, basis: 'write',
  concurrentContainers: 2, container: { vcpu: 0.5, memoryGiB: 4, diskGB: 8, cpuBusy: 1 }, runnerHoursPerMonth: 0, runnerHourlyRate: null };

const number = (value, min, max, name) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${name} must be a number from ${min} to ${max}.`); return value; };
const optional = (value, max, name) => value === null || value === undefined ? null : number(value, 0, max, name);
export function validScenario(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Send the scenario.');
  const container = input.container || {};
  if (!['write', 'land'].includes(input.basis)) invalid('Scale activity by applied writes or by landed pull requests.');
  return { agents: number(input.agents, 0, 100_000, 'Agents'), writesPerAgentPerMinute: number(input.writesPerAgentPerMinute, 0, 1000, 'Writes per agent per minute'),
    activeHoursPerDay: number(input.activeHoursPerDay, 0, 24, 'Active hours per day'), prsLandedPerDay: number(input.prsLandedPerDay, 0, 10_000_000, 'Pull requests landed per day'),
    ciRunsPerDay: number(input.ciRunsPerDay, 0, 10_000_000, 'CI runs per day'), basis: input.basis, concurrentContainers: number(input.concurrentContainers, 0, 10_000, 'Concurrent containers'),
    container: { vcpu: number(container.vcpu, 0.0625, 4, 'Container vCPU'), memoryGiB: number(container.memoryGiB, 0.25, 12, 'Container memory'), diskGB: number(container.diskGB, 1, 20, 'Container disk'),
      cpuBusy: number(container.cpuBusy, 0, 1, 'Container CPU busy share') },
    runnerHoursPerMonth: number(input.runnerHoursPerMonth, 0, 1_000_000, 'Runner hours per month'), runnerHourlyRate: optional(input.runnerHourlyRate, 1000, 'Runner hourly rate') };
}
export function validUnits(input) {
  if (!Array.isArray(input) || input.length > 40) invalid('Send the unit costs as a list.');
  const known = new Set([...activityRates, ...ciRates, ...storageRates]), seen = new Map();
  for (const unit of input) {
    if (!unit || !known.has(unit.rate) || seen.has(unit.rate)) invalid('Unknown or repeated unit cost.');
    seen.set(unit.rate, { rate: unit.rate, perWrite: optional(unit.perWrite, 1e12, 'A unit cost'), perLand: optional(unit.perLand, 1e12, 'A unit cost'),
      perCiRun: optional(unit.perCiRun, 1e12, 'A unit cost'), current: optional(unit.current, 1e9, 'A storage size') });
  }
  return seen;
}

// The what-if: projected monthly usage per rate from the scenario and the unit costs, priced against the full monthly allowance (as if
// this installation were the only user of the account). Rates with no unit cost are listed as not estimated.
export function estimate(scenario, units) {
  const month = daysPerMonth, writes = scenario.agents * scenario.writesPerAgentPerMinute * 60 * scenario.activeHoursPerDay * month;
  const landed = scenario.prsLandedPerDay * month, ciRuns = scenario.ciRunsPerDay * month, containerSeconds = scenario.concurrentContainers * 24 * month * 3600;
  const drivers = { writesPerMonth: round(writes, 2), landedPerMonth: round(landed, 2), ciRunsPerMonth: round(ciRuns, 2), containerSecondsPerMonth: round(containerSeconds, 2), daysPerMonth: month };
  const lines = [], line = (id, usage, basis) => {
    const item = rateById.get(id);
    lines.push(usage === null ? { rate: id, service: item.service, label: item.label, unit: item.unit, state: 'not-estimated', basis, reason: 'No unit cost: none was measured or entered.' }
      : { rate: id, service: item.service, label: item.label, unit: item.unit, state: 'estimated', basis, usage: round(usage, 3), included: item.included, billable: round(billable(item, usage), 3), cost: priced(item, usage) });
  };
  line('workers.subscription', 1, 'Fixed monthly fee');
  for (const id of activityRates) {
    const unit = units.get(id), value = scenario.basis === 'land' ? unit?.perLand : unit?.perWrite;
    line(id, value === null || value === undefined ? null : value * (scenario.basis === 'land' ? landed : writes), scenario.basis === 'land' ? 'Per landed pull request' : 'Per applied write');
  }
  for (const id of ciRates) { const value = units.get(id)?.perCiRun; line(id, value === null || value === undefined ? null : value * ciRuns, 'Per CI run'); }
  for (const id of storageRates) { const value = units.get(id)?.current; line(id, value === null || value === undefined ? null : value, 'Current size, not scaled'); }
  const c = scenario.container;
  line('containers.cpu', containerSeconds * c.vcpu * c.cpuBusy, 'Concurrent containers × vCPU × busy share');
  line('containers.memory', containerSeconds * c.memoryGiB, 'Concurrent containers × memory');
  line('containers.disk', containerSeconds * c.diskGB, 'Concurrent containers × disk');
  const runners = scenario.runnerHourlyRate === null ? { service: 'runners', label: 'Runner hours', unit: 'hours', state: 'not-priced', basis: 'Outside Cloudflare', usage: scenario.runnerHoursPerMonth,
    reason: 'Self-hosted runners run outside Cloudflare. Enter your hourly rate to include them.' }
    : { service: 'runners', label: 'Runner hours', unit: 'hours', state: 'estimated', basis: 'Outside Cloudflare, at the entered hourly rate', usage: scenario.runnerHoursPerMonth, included: 0,
      billable: scenario.runnerHoursPerMonth, cost: round(scenario.runnerHoursPerMonth * scenario.runnerHourlyRate) };
  lines.push({ rate: 'runners.hours', ...runners });
  const services = Object.keys(serviceLabels).map(id => {
    const own = lines.filter(item => item.service === id); if (!own.length) return null;
    const counted = own.filter(item => item.state === 'estimated');
    return { id, label: serviceLabels[id], cost: counted.length ? round(counted.reduce((sum, item) => sum + item.cost, 0)) : null, missing: own.filter(item => item.state !== 'estimated').map(item => item.label) };
  }).filter(Boolean);
  const missing = lines.filter(item => item.state !== 'estimated').map(item => `${serviceLabels[item.service]}: ${item.label}`);
  return { drivers, lines, services, total: round(lines.filter(item => item.state === 'estimated').reduce((sum, item) => sum + item.cost, 0)), missing,
    notEstimated: ['Durable Object SQLite rows and storage', 'Artifacts storage', 'Workers AI neurons (see AI usage)', 'Vectorize'] };
}

// ----- Reading usage from the GraphQL Analytics API. -----
const endpoint = 'https://api.cloudflare.com/client/v4/graphql';
const sanitize = text => String(text || '').replace(/[A-Za-z0-9_-]{32,}/g, '[withheld]').replace(/\s+/g, ' ').slice(0, 200);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const literal = value => JSON.stringify(value);
const date = ms => new Date(ms).toISOString().slice(0, 10);
export class AnalyticsError extends Error {}

// One GraphQL request. Values are validated before they are written into the query, so no variable types are relied on.
export async function analyticsQuery(token, body, providerFetch) {
  let response;
  try {
    response = await providerFetch(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query: body }) });
  } catch (error) { throw new AnalyticsError(error?.name === 'TimeoutError' ? 'The analytics API did not answer within 5 seconds.' : 'The analytics API could not be reached.'); }
  if (response.status === 401 || response.status === 403) throw new AnalyticsError(`The analytics token was refused (HTTP ${response.status}). It needs Account Analytics Read on this account.`);
  if (!response.headers.get('Content-Type')?.startsWith('application/json')) throw new AnalyticsError(`The analytics API answered ${response.status} without JSON.`);
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(response.body, 256 * 1024))); }
  catch (error) { throw new AnalyticsError(error?.name === 'TimeoutError' ? 'The analytics API did not answer within 5 seconds.' : 'The analytics answer could not be read.'); }
  if (Array.isArray(data?.errors) && data.errors.length) {
    const message = sanitize(data.errors[0]?.message);
    throw new AnalyticsError(/authz|authoriz|permission|not allowed|access/i.test(message) ? 'The analytics token lacks permission for this dataset: ' + message : 'The analytics API refused the query: ' + message);
  }
  if (!response.ok) throw new AnalyticsError(`The analytics API answered ${response.status}.`);
  const accounts = data?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new AnalyticsError('The analytics answer had an unexpected shape.');
  return accounts[0];
}

const shape = () => { throw new AnalyticsError('The analytics answer had an unexpected shape.'); };
// Sums one field over grouped rows. An empty list is zero only where the caller says an empty dataset is plausible.
function total(rows, pick, emptyOK, what) {
  if (!Array.isArray(rows)) shape();
  if (!rows.length && !emptyOK) throw new AnalyticsError(`The ${what} dataset returned no rows although this installation is serving requests.`);
  return rows.reduce((sum, row) => { const value = pick(row); if (!finite(value)) shape(); return sum + value; }, 0);
}

// Each probe is one request with a month-to-date and a window alias, so an unconfirmed field fails only its own lines.
// `confirmed` records whether the dataset and fields were confirmed (published docs or a live read) when this was written.
export function probes(env, period, window) {
  const account = `accounts(filter: {accountTag: ${literal(env.ACCOUNT_ID)}})`;
  const bothTimes = (dataset, body, filters) => `query { viewer { ${account} {
    mtd: ${dataset}(${filters(period.start, period.now, date(Date.parse(period.start) - day))}) ${body}
    win: ${dataset}(${filters(window.start, window.end, date(Date.parse(window.start) - day))}) ${body}
  } } }`;
  const worker = env.OPERATIONS_WORKER, database = env.OPERATIONS_DATABASE_ID, buckets = String(env.OPERATIONS_BUCKETS || '').split(',').filter(Boolean);
  const workerFilter = (start, end) => `limit: 2, filter: {scriptName: ${literal(worker)}, datetime_geq: ${literal(start)}, datetime_leq: ${literal(end)}}`;
  const oneScript = (rows, pick) => { if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => row.dimensions?.scriptName !== worker)) shape(); return total(rows, pick, false, 'Workers'); };
  const both = (account, read) => ({ mtd: read(account.mtd), win: read(account.win) });
  const list = [
    { id: 'workers', service: 'workers', rates: ['workers.requests'], confirmed: true, scope: 'worker', available: /^[a-z0-9-]{3,63}$/.test(worker || ''),
      unavailable: 'The Worker name is not configured on this deploy.',
      query: () => bothTimes('workersInvocationsAdaptive', '{ dimensions { scriptName } sum { requests } }', workerFilter),
      read: account => both(account, rows => ({ 'workers.requests': oneScript(rows, row => row.sum?.requests) })) },
    { id: 'workers-cpu', service: 'workers', rates: ['workers.cpu'], confirmed: false, scope: 'worker', available: /^[a-z0-9-]{3,63}$/.test(worker || ''),
      unavailable: 'The Worker name is not configured on this deploy.',
      query: () => bothTimes('workersInvocationsAdaptive', '{ dimensions { scriptName } sum { cpuTimeUs } }', workerFilter),
      read: account => both(account, rows => ({ 'workers.cpu': oneScript(rows, row => row.sum?.cpuTimeUs) / 1000 })) },
    { id: 'do-requests', service: 'do', rates: ['do.requests'], confirmed: true, scope: 'account', available: true,
      query: () => bothTimes('durableObjectsInvocationsAdaptiveGroups', '{ sum { requests } }', (start, end, before) => `limit: 1, filter: {date_gt: ${literal(before)}}`),
      read: account => both(account, rows => ({ 'do.requests': total(rows, row => row.sum?.requests, false, 'Durable Objects') })) },
    { id: 'do-periodic', service: 'do', rates: ['do.duration'], confirmed: true, scope: 'account', available: true,
      query: () => bothTimes('durableObjectsPeriodicGroups', '{ sum { activeTime } }', (start, end, before) => `limit: 1, filter: {date_gt: ${literal(before)}}`),
      // activeTime is in microseconds; duration is billed for 128 MB per object: seconds × 128 MB / 1 GB.
      read: account => both(account, rows => ({ 'do.duration': total(rows, row => row.sum?.activeTime, false, 'Durable Objects') / 1e6 * 0.128 })) },
    { id: 'd1', service: 'd1', rates: ['d1.rows-read', 'd1.rows-written'], confirmed: true, scope: database ? 'database' : 'account', available: Boolean(env.DB),
      query: () => bothTimes('d1AnalyticsAdaptiveGroups', '{ sum { rowsRead rowsWritten } }',
        (start, end) => `limit: 1, filter: {date_geq: ${literal(start.slice(0, 10))}, date_leq: ${literal(end.slice(0, 10))}${database ? `, databaseId: ${literal(database)}` : ''}}`),
      read: account => both(account, rows => ({ 'd1.rows-read': total(rows, row => row.sum?.rowsRead, false, 'D1'), 'd1.rows-written': total(rows, row => row.sum?.rowsWritten, false, 'D1') })) },
    { id: 'd1-storage', service: 'd1', rates: ['d1.storage'], confirmed: false, scope: 'database', available: Boolean(env.DB && database),
      unavailable: 'The D1 database id is not bound on this deploy (OPERATIONS_DATABASE_ID), so its size cannot be told apart from other databases on the account.',
      query: () => `query { viewer { ${account} {
        now: d1StorageAdaptiveGroups(limit: 1, filter: {date_geq: ${literal(date(Date.parse(period.now) - day))}, databaseId: ${literal(database)}}) { max { databaseSizeBytes } }
      } } }`,
      read: account => { const size = total(account.now, row => row.max?.databaseSizeBytes, false, 'D1 storage') / 1e9; return { mtd: { 'd1.storage': size }, win: { 'd1.storage': size } }; } },
    { id: 'r2', service: 'r2', rates: ['r2.class-a', 'r2.class-b'], confirmed: true, scope: buckets.length ? 'buckets' : 'account', available: Boolean(env.EVIDENCE_BUCKET || env.PIPELINE_BUCKET),
      query: () => bothTimes('r2OperationsAdaptiveGroups', '{ sum { requests } dimensions { actionType bucketName } }',
        (start, end) => `limit: 1000, filter: {datetime_geq: ${literal(start)}, datetime_leq: ${literal(end)}}`),
      read: account => both(account, rows => r2Operations(rows, buckets)) },
    { id: 'r2-storage', service: 'r2', rates: ['r2.storage'], confirmed: true, scope: buckets.length ? 'buckets' : 'account', available: Boolean(env.EVIDENCE_BUCKET || env.PIPELINE_BUCKET),
      query: () => `query { viewer { ${account} {
        now: r2StorageAdaptiveGroups(limit: 1000, filter: {datetime_geq: ${literal(new Date(Date.parse(period.now) - day).toISOString())}, datetime_leq: ${literal(period.now)}}) { max { payloadSize metadataSize } dimensions { bucketName } }
      } } }`,
      read: account => { const size = r2Storage(account.now, buckets); return { mtd: { 'r2.storage': size }, win: { 'r2.storage': size } }; } },
    { id: 'queues', service: 'queues', rates: ['queues.operations'], confirmed: true, scope: 'account', available: Boolean(env.EVIDENCE_QUEUE || env.PIPELINE_QUEUE),
      query: () => bothTimes('queueMessageOperationsAdaptiveGroups', '{ sum { billableOperations } }',
        (start, end) => `limit: 1, filter: {datetime_geq: ${literal(start)}, datetime_leq: ${literal(end)}}`),
      read: account => both(account, rows => ({ 'queues.operations': total(rows, row => row.sum?.billableOperations, true, 'Queues') })) },
    { id: 'artifacts', service: 'artifacts', rates: ['artifacts.operations'], confirmed: true, scope: 'namespace', available: Boolean(env.ARTIFACTS && /^[a-z0-9][a-z0-9-]{1,62}$/.test(env.ARTIFACTS_NAMESPACE || '')),
      unavailable: 'The Artifacts namespace is not configured on this deploy.',
      // Operations as Artifacts counts them: create, fork, push, pull and delete events, successful or not.
      query: () => bothTimes('artifactsEventsAdaptiveGroups', '{ count }',
        (start, end) => `limit: 1, filter: {datetime_geq: ${literal(start)}, datetime_leq: ${literal(end)}, repositoryNamespace: ${literal(env.ARTIFACTS_NAMESPACE)}}`),
      read: account => both(account, rows => ({ 'artifacts.operations': total(rows, row => row.count, true, 'Artifacts') })) },
  ];
  return list;
}

// R2 operation classes as the pricing page lists them; an action it does not list is priced as Class A (the higher rate) and named.
const classA = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration']);
const classB = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration']);
const free = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);
export function r2Operations(rows, buckets) {
  if (!Array.isArray(rows) || rows.length >= 1000) shape();
  const out = { 'r2.class-a': 0, 'r2.class-b': 0 }, unlisted = new Set();
  for (const row of rows) {
    const action = row.dimensions?.actionType, bucket = row.dimensions?.bucketName, requests = row.sum?.requests;
    if (typeof action !== 'string' || typeof bucket !== 'string' || !finite(requests)) shape();
    if (buckets.length && !buckets.includes(bucket)) continue;
    if (free.has(action)) continue;
    if (classB.has(action)) out['r2.class-b'] += requests;
    else { out['r2.class-a'] += requests; if (!classA.has(action)) unlisted.add(action.slice(0, 40)); }
  }
  if (unlisted.size) out.note = `Priced as Class A (not on the pricing page's lists): ${[...unlisted].slice(0, 5).join(', ')}.`;
  return out;
}
export function r2Storage(rows, buckets) {
  if (!Array.isArray(rows) || rows.length >= 1000) shape();
  const largest = new Map();
  for (const row of rows) {
    const bucket = row.dimensions?.bucketName, size = (row.max?.payloadSize ?? NaN) + (row.max?.metadataSize ?? NaN);
    if (typeof bucket !== 'string' || !finite(size)) shape();
    if (buckets.length && !buckets.includes(bucket)) continue;
    largest.set(bucket, Math.max(largest.get(bucket) || 0, size));
  }
  return [...largest.values()].reduce((sum, value) => sum + value, 0) / 1e9;
}

const scopes = { worker: 'This Worker only (its preview, outbound and application Workers are not included).', database: 'This installation’s D1 database.',
  buckets: 'This installation’s R2 buckets.', namespace: 'This installation’s Artifacts namespace.', account: 'The whole Cloudflare account: Golf cannot tell its own share apart here.' };

// Runs every probe in parallel; each settles to observed values or a reason. Nothing that failed is reported as a number.
export async function readUsage(env, period, window, providerFetch = fetch) {
  const list = probes(env, period, window), results = new Map();
  const set = (probe, state, reason, values = null) => { for (const id of probe.rates) results.set(id, { state, reason, probe: probe.id, scope: probe.scope, confirmed: probe.confirmed, values: values && { mtd: values.mtd[id], win: values.win[id], note: values.mtd.note || '' } }); };
  if (!env.OPERATIONS_ANALYTICS_TOKEN?.get) {
    for (const probe of list) set(probe, 'unreadable', 'No Account Analytics Read token is bound (enable-analytics), so usage cannot be read.');
    return { state: 'unavailable', reason: 'No Account Analytics Read token is bound (enable-analytics). Rates, Golf’s own counts and the what-if still work; usage is not read.', results };
  }
  let token;
  try {
    if (!/^[a-f0-9]{32}$/.test(env.ACCOUNT_ID || '')) throw Error('The Cloudflare account ID is not configured.');
    token = await env.OPERATIONS_ANALYTICS_TOKEN.get();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw Error('The analytics credential is unavailable.');
  } catch (error) {
    for (const probe of list) set(probe, 'unreadable', sanitize(error?.message));
    return { state: 'degraded', reason: sanitize(error?.message), results };
  }
  await Promise.all(list.map(async probe => {
    if (!probe.available) return set(probe, 'not-configured', probe.unavailable || 'Not configured on this installation.');
    try { set(probe, 'observed', '', probe.read(await analyticsQuery(token, probe.query(), providerFetch))); }
    catch (error) { set(probe, 'degraded', error instanceof AnalyticsError ? error.message : 'The analytics answer could not be read.'); }
  }));
  const states = [...results.values()].filter(item => item.state !== 'not-configured').map(item => item.state);
  const reasons = [...new Set([...results.values()].filter(item => item.state === 'degraded').map(item => item.reason))];
  return { state: states.every(state => state === 'observed') ? 'observed' : states.some(state => state === 'observed') ? 'partial' : 'degraded',
    reason: reasons.length === 1 ? reasons[0] : reasons.length ? `${reasons.length} different failures; each service names its own.` : '', results };
}

// Golf's own exact counts. A table this schema lacks is reported as unknown, never as zero.
async function count(db, sql, since) { try { const row = await db.prepare(sql).bind(since).first(); return Number.isSafeInteger(row?.n) ? row.n : null; } catch { return null; } }
export async function golfCounts(db, since) {
  const writes = await count(db, "SELECT count(*) AS n FROM git_operations WHERE state='APPLIED' AND created_at>=?", since);
  const landed = await count(db, "SELECT count(*) AS n FROM land_operations WHERE state='LANDED' AND updated_at>=?", since);
  const pipelines = await count(db, 'SELECT count(*) AS n FROM pipeline_runs WHERE created_at>=?', since);
  const tests = await count(db, "SELECT count(*) AS n FROM evidence_jobs WHERE test_state!='NONE' AND created_at>=?", since);
  const aiRuns = await count(db, 'SELECT count(*) AS n FROM ai_runs WHERE created_at>=?', since);
  const agentTasks = await count(db, 'SELECT count(*) AS n FROM agent_tasks WHERE created_at>=?', since);
  return { since, writes, landed, pipelines, tests, ciRuns: pipelines === null && tests === null ? null : (pipelines || 0) + (tests || 0), aiRuns, agentTasks };
}

const containersConfigured = env => env.TEST_EXECUTION_ENABLED === 'true' || env.AGENT_EXECUTION_ENABLED === 'true' || env.SSH_HOSTS_EXECUTION === 'true';
// Configured services Golf does not read or price, listed so they are never mistaken for free.
function unpriced(env) {
  return [
    containersConfigured(env) && { id: 'containers', label: 'Containers', reason: 'No usage dataset is confirmed for Containers. Estimate them in the what-if from concurrent containers.' },
    env.AI && { id: 'ai', label: 'Workers AI', reason: 'Neurons are not read here. Golf’s own AI run ledger and AI Gateway cost are on the AI usage page.' },
    env.SEARCH_INDEX && { id: 'vectorize', label: 'Vectorize', reason: 'No usage dataset is confirmed for Vectorize.' },
    (env.EVIDENCE_WORKFLOW_NAME || env.AI_WORKFLOW_NAME) && { id: 'workflows', label: 'Workflows', reason: 'Not priced here; Workflows steps and storage have their own billing start date.' },
    env.OPERATIONS_OBSERVABILITY === 'true' && { id: 'logs', label: 'Workers Logs', reason: 'Log events are not read here.' },
    env.APP_DISPATCH && { id: 'platforms', label: 'Workers for Platforms', reason: 'Priced on its own plan; not estimated here.' },
    env.BROWSER && { id: 'browser', label: 'Browser Rendering', reason: 'Not priced here.' },
    env.EMAIL && { id: 'email', label: 'Email Service', reason: 'Not priced here.' },
  ].filter(Boolean);
}

export async function costsRead(db, env, providerFetch, now = Date.now()) {
  const period = monthPeriod(now), windowStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 7 * day;
  const window = { start: new Date(windowStart).toISOString(), end: new Date(now).toISOString(), days: round((now - windowStart) / day, 3) };
  const [usage, month, measured] = await Promise.all([readUsage(env, period, window, providerFetch), golfCounts(db, period.start), golfCounts(db, window.start)]);
  const services = ['workers', 'do', 'd1', 'r2', 'queues', 'artifacts'].map(id => {
    const configured = id === 'r2' ? Boolean(env.EVIDENCE_BUCKET || env.PIPELINE_BUCKET) : id === 'queues' ? Boolean(env.EVIDENCE_QUEUE || env.PIPELINE_QUEUE) : id === 'artifacts' ? Boolean(env.ARTIFACTS) : id === 'd1' ? Boolean(env.DB) : true;
    if (!configured) return { id, label: serviceLabels[id], state: 'not-configured', reason: 'Not configured on this installation.', lines: [] };
    const lines = rates.filter(item => item.service === id && !(id === 'workers' && item.fixed)).map(item => {
      const result = usage.results.get(item.id);
      const observed = !result ? { state: 'unreadable', reason: id === 'do' ? 'Golf has not confirmed a dataset field for this rate.' : id === 'artifacts' ? 'Artifacts storage is not in its analytics dataset.' : 'Not read.' }
        : result.state === 'observed' ? { state: 'observed', value: result.values.mtd, note: result.values.note } : { state: result.state === 'not-configured' ? 'unreadable' : result.state, reason: result.reason };
      return { ...runningLine(item, observed, period), scope: result?.scope || '', confirmed: result?.confirmed ?? false };
    });
    const scope = [...new Set(lines.map(line => line.scope).filter(Boolean))];
    return { id, label: serviceLabels[id], source: pricingPages[id], scopes: scope.map(key => scopes[key]), lines, ...serviceTotal(lines) };
  });
  const subscription = rateById.get('workers.subscription');
  const fixed = { rate: subscription.id, label: subscription.label, costMonthToDate: round(subscription.price * period.elapsedDays / period.days), costProjected: subscription.price, source: subscription.source };
  const read = services.filter(service => service.costProjected !== undefined);
  const missing = services.flatMap(service => service.state === 'not-configured' ? [] : service.missing.map(label => `${service.label}: ${label}`));
  const windowUsage = Object.fromEntries([...usage.results].filter(([, result]) => result.state === 'observed').map(([id, result]) => [id, result.values.win]));
  return { generatedAt: new Date(now).toISOString(), pricesAsOf, plan: 'Workers Paid', period, window, analytics: { state: usage.state, reason: usage.reason },
    services, subscription: fixed, unpriced: unpriced(env),
    totals: { costMonthToDate: round(fixed.costMonthToDate + read.reduce((sum, service) => sum + service.costMonthToDate, 0)), costProjected: round(fixed.costProjected + read.reduce((sum, service) => sum + service.costProjected, 0)), missing },
    counts: { month, window: measured }, units: measuredUnits(windowUsage, measured), scenario: defaultScenario, rates, pricingPages };
}

// `/native/costs/read` { action: 'read' } or { action: 'estimate', scenario, units }: operations administrators only, checked before and
// after the reads. The estimate is pure arithmetic on what the administrator submitted; it reads no analytics.
export async function costsAPI(db, env, person, request, body, providerFetch = fetch) {
  const requireAdmin = async () => { if (!await operationsAdmin(db, person, request)) throw new Fault('permission_denied', 403, 'Current workspace operations administrator sign-in required.'); };
  await requireAdmin();
  if (body.action === 'estimate') {
    const result = estimate(validScenario(body.scenario), validUnits(body.units));
    return reply({ pricesAsOf, ...result });
  }
  if (body.action !== 'read') invalid('Use the read or estimate action.');
  const result = await costsRead(db, env, providerFetch);
  await requireAdmin();
  return reply(result);
}
