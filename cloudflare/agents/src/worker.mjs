import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Files, SandboxFileError } from '@cloudflare/sandbox';
import { authorized, boundedBody, gitOperation, inference, maxCalls, maxBody, maxOutput, model, filePolicy, nativePolicy, openAIStream, policy, projectedEvents, roles, sha } from './policy.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'lost']);
const trust = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/auth',
  XDG_DATA_HOME: '/auth/data', XDG_CONFIG_HOME: '/auth/config', XDG_CACHE_HOME: '/auth/cache',
  NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
  GIT_SSL_CAINFO: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
  GIT_CONFIG_NOSYSTEM: '1', SSL_CERT_FILE: '/etc/cloudflare/certs/cloudflare-containers-ca.crt', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false',
  GIT_CONFIG_KEY_3: 'user.name', GIT_CONFIG_VALUE_3: 'Golf Cloudflare task',
  GIT_CONFIG_KEY_4: 'user.email', GIT_CONFIG_VALUE_4: 'task@golf.invalid',
  OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
  OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_SHARE: 'true',
  OPENCODE_CONFIG: '/auth/opencode.json', NO_COLOR: '1',
};
const reply = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
} });
const digest = async v => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))), b => b.toString(16).padStart(2, '0')).join('');
function diagnostic(error, env) {
  let value = String(error?.message || 'Runtime operation failed');
  for (const key of ['GOLF_PROBE_TOKEN', ...roles.flatMap(role => ['READ', 'WRITE'].map(scope => `GIT_${role.replaceAll('-', '_').toUpperCase()}_${scope}`))]) {
    if (env[key]) value = value.replaceAll(env[key], '[withheld]');
  }
  return value.replace(/[A-Za-z0-9_-]{32,}/g, '[withheld]').slice(0, 2048);
}

// This export is reachable only through container interception, never routing.
export class Outbound extends WorkerEntrypoint {
  async fetch(request) {
    const role = this.ctx.props?.role;
    if (!roles.includes(role)) return reply({ state: 'denied' }, 403);
    return this.ctx.exports.AgentTask.getByName(role).outbound(request);
  }
}

export class AgentTask extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.container = ctx.container;
    if (!this.container) throw new Error('container unavailable');
    this.files = new Files(this.container);
    if (this.container.running) ctx.blockConcurrencyWhile(() => this.container.setInactivityTimeout(30000));
  }
  get record() { return this.ctx.storage.kv.get('task'); }
  set record(value) { this.ctx.storage.kv.put('task', value); }
  remote(role) { return `https://${this.env.GOLF_ACCOUNT_ID}.artifacts.cloudflare.net/git/${this.env.GOLF_NAMESPACE}/${role}.git`; }
  credential(role, scope) { return this.env[`GIT_${role.replaceAll('-', '_').toUpperCase()}_${scope.toUpperCase()}`]; }
  outboundService(role) { return this.ctx.exports.Outbound({ props: { role } }); }
  // A job admitted with a model (native proposals) runs exactly that model; the fixture roles keep the default.
  admittedModel() { return this.record?.model || model; }
  executionPolicy() { return this.record?.allowed_path ? filePolicy(this.record.allowed_path, this.admittedModel()) : policy; }
  async authorize() {}
  cloneArgs(r) { return ['--depth', '1', '--branch', r.branch || 'master']; }
  validateProposal() {}
  async tests(r) {
    const target = await this.run(['python3', '-m', 'unittest', '-v', r.role === 'agent-a' ? 'test_calc.Math.test_add' : 'test_calc.Math.test_multiply']);
    const full = await this.run(['python3', '-m', 'unittest', '-v', 'test_calc']);
    return { target, full };
  }
  async create(role, input) {
    if (!roles.includes(role) || !input || typeof input.prompt !== 'string' || !input.prompt.trim() ||
        new TextEncoder().encode(input.prompt).length > 16384 || !Number.isSafeInteger(input.timeout_ms) ||
        input.timeout_ms < 1000 || input.timeout_ms > 120000) throw new Error('invalid admission');
    const commit = role === 'integration' ? input.commit : this.env.GOLF_BASE_COMMIT;
    const tree = role === 'integration' ? input.tree : this.env.GOLF_BASE_TREE;
    if (!sha.test(commit || '') || !sha.test(tree || '')) throw new Error('invalid source identity');
    const promptHash = await digest(input.prompt);
    if (this.record) return { state: 'conflict' };
    this.record = { schema_version: 'golf.cloudflare.agent-task.v1', role, state: 'preparing',
      stage: 'admitted', prompt: input.prompt, prompt_sha256: promptHash,
      base_commit: commit, base_tree: tree, timeout_ms: input.timeout_ms,
      created_at: Date.now(), calls: 0, denied: 0, events: [] };
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return { state: 'preparing' };
  }
  async run(args, cwd = '/workspace/repo', env = trust) {
    const process = await this.container.exec(args, { cwd, env, ...(args[0] === 'opencode' ? { user: '1000:1000' } : {}) });
    const out = await process.output();
    if (out.stdout.byteLength + out.stderr.byteLength > 1 << 20) throw new Error('command output exceeds bound');
    const decode = new TextDecoder('utf-8', { fatal: true });
    return { exit_code: out.exitCode, stdout: decode.decode(out.stdout), stderr: decode.decode(out.stderr) };
  }
  async checked(args, cwd, env) {
    const result = await this.run(args, cwd, env);
    if (result.exit_code !== 0) throw new Error('trusted command failed: ' + result.stderr.slice(0, 512));
    return result.stdout.trim();
  }
  phase(stage, state) {
    const r = this.record;
    if (!r || terminal.has(r.state)) throw new Error('task ended');
    this.record = { ...r, stage, ...(state ? { state } : {}) };
  }
  async prepare() {
    const r = this.record;
    await this.authorize();
    // Persist dispatch before starting. A lost acknowledgement is never retried.
    this.phase('container_dispatch');
    const outbound = this.outboundService(r.role);
    this.phase('http_intercept');
    await this.container.interceptAllOutboundHttp(outbound);
    this.phase('https_intercept');
    await this.container.interceptOutboundHttps('*', outbound);
    this.phase('container_start');
    this.container.start({ image: this.container.images.agent, instance: 'standard-1', entrypoint: ['sleep', 'infinity'], enableInternet: false });
    this.ctx.waitUntil(this.container.monitor().catch(error => {
      this.ctx.storage.kv.put('container_failure', diagnostic(error, this.env));
    }));
    this.phase('container_ready');
    await this.checked(['/bin/true'], '/workspace');
    this.phase('inactivity');
    await this.container.setInactivityTimeout(30000);
    this.phase('clone');
    await this.checked(['timeout', '--signal=TERM', '--kill-after=5s', '60s', 'git', 'clone', ...this.cloneArgs(r), '--', this.remote(r.role), '/workspace/repo'], '/workspace');
    const head = await this.checked(['git', 'rev-parse', 'HEAD']);
    const tree = await this.checked(['git', 'rev-parse', 'HEAD^{tree}']);
    if (head !== r.base_commit || tree !== r.base_tree) throw new Error('source moved before execution');
    await this.checked(['chown', '-R', '1000:1000', '/workspace/repo']);
    await this.checked(['opencode', '--version'], '/workspace', trust).then(v => { if (v !== '1.18.34') throw new Error('native version differs'); });
    if (r.role === 'integration') {
      this.phase('test');
      const tests = await this.run(['python3', '-m', 'unittest', '-v', 'test_calc']);
      await this.finish(tests.exit_code === 0 ? 'succeeded' : 'failed', { proposal_commit: head, proposal_tree: tree, tests: { full: tests } });
      return;
    }
    await this.authorize();
    await this.files.writeFile('/auth/opencode.json', JSON.stringify(this.executionPolicy()));
    const resolved = JSON.parse(await this.checked(['opencode', 'debug', 'agent', 'golf-workspace']));
    this.record = { ...this.record, native_policy: { name: resolved.name,
      enabled_tools: Object.entries(resolved.tools || {}).filter(([, enabled]) => enabled).map(([name]) => name),
      permission: resolved.permission } };
    if (!nativePolicy(resolved, r.allowed_path || 'calc.py')) throw new Error('native file policy differs');
    this.phase('agent', 'running');
    this.record = { ...this.record, started_at: Date.now(), deadline: Date.now() + r.timeout_ms };
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    const script = `dir=$1; seconds=$2; shift 2
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' "$dir" timeout --signal=TERM --kill-after=5s "$seconds" "$@" >"$dir/events.jsonl" 2>"$dir/stderr.log"
code=$?; printf '%s' "$code" >"$dir/exit.tmp"; mv "$dir/exit.tmp" "$dir/exit"`;
    await this.container.exec(['/bin/sh', '-c', script, 'golf', '/workspace/task', String(Math.ceil(r.timeout_ms / 1000)),
      'opencode', 'run', '--format', 'json', '--auto', '--agent', 'golf-workspace', '--model', 'golf/coder', '--', r.prompt],
      { cwd: '/workspace/repo', env: trust, user: '1000:1000', stdout: 'ignore', stderr: 'ignore' });
  }
  async optional(path) {
    try { const response = await this.files.readFile(path); return await boundedBody(response, 1 << 20); }
    catch (e) { if (SandboxFileError.is(e) && e.code === 'ENOENT') return null; throw e; }
  }
  async observe() {
    const r = this.record;
    if (!this.container.running) { await this.finish('lost'); return; }
    const code = await this.optional('/workspace/task/exit');
    const events = projectedEvents((await this.optional('/workspace/task/events.jsonl')) || '', code !== null);
    this.record = { ...this.record, events: events.events.map(event => event.kind === 'error' ? {
      kind: 'error', name: diagnostic(new Error(event.name), this.env), message: diagnostic(new Error(event.message), this.env),
    } : event.error ? { ...event, error: diagnostic(new Error(event.error), this.env) } : event), tokens: events.tokens };
    if (code === null) {
      if (Date.now() >= r.deadline) { await this.finish('timed_out'); return; }
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }
    if (!/^[0-9]{1,3}$/.test(code)) throw new Error('invalid native exit');
    if (+code === 124 || +code === 137) { await this.finish('timed_out'); return; }
    if (+code !== 0 || !events.complete || !events.tokens || !r.calls) {
      const stderr = await this.optional('/workspace/task/stderr.log');
      await this.finish('failed', { native_exit_code: +code, process_failure: diagnostic(new Error(stderr || 'Native completion/usage missing'), this.env) });
      return;
    }
    this.record = { ...this.record, agent_completed_at: Date.now() };
    this.phase('proposal');
    await this.authorize();
    const names = await this.checked(['git', 'diff', '--name-only', 'HEAD']);
    const unknown = await this.checked(['git', 'ls-files', '--others', '--exclude-standard']);
    if (names !== (r.allowed_path || 'calc.py') || unknown) throw new Error('proposal changed inadmissible files');
    const patch = await this.checked(['git', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD']);
    await this.checked(['git', 'add', '--', r.allowed_path || 'calc.py']);
    const mode = await this.checked(['git', 'ls-files', '-s', '--', r.allowed_path || 'calc.py']);
    if (!/^100(?:644|755) [a-f0-9]{40} 0\t/.test(mode)) throw new Error('proposal source is not a regular file');
    await this.checked(['git', 'commit', '-m', 'Golf Cloudflare agent proposal']);
    const commit = await this.checked(['git', 'rev-parse', 'HEAD']);
    const tree = await this.checked(['git', 'rev-parse', 'HEAD^{tree}']);
    this.phase('test');
    const tests = await this.tests(r);
    if (tests.target && tests.target.exit_code !== 0) { await this.finish('failed', { tests }); return; }
    if (await this.checked(['git', 'rev-parse', 'HEAD']) !== commit || await this.checked(['git', 'rev-parse', 'HEAD^{tree}']) !== tree) throw new Error('tests moved the proposal');
    await this.checked(['git', 'diff', '--exit-code', 'HEAD']);
    this.validateProposal(patch, tests);
    // Only a stopped native CLI and controller-issued Git can publish.
    this.phase('publish');
    await this.authorize();
    await this.checked(['timeout', '--signal=TERM', '--kill-after=5s', '60s', 'git', 'push', this.remote(r.role), 'HEAD:refs/heads/' + (r.branch || 'master')]);
    this.phase('verify');
    const original = await this.checked(['git', 'rev-parse', 'HEAD']);
    if (original !== commit) throw new Error('proposal moved during publication');
    await this.finish('succeeded', { proposal_commit: commit, proposal_tree: tree, patch, tests });
  }
  async finish(state, result = {}) {
    const r = this.record;
    if (!r || terminal.has(r.state)) return;
    this.record = { ...r, state, stage: 'terminal', terminal_from: r.stage, finished_at: Date.now(), ...result };
    await this.ctx.storage.deleteAlarm();
    try { await this.container.destroy(); }
    catch { this.record = { ...this.record, state: 'lost', cleanup: 'failed' }; return; }
    this.record = { ...this.record, cleanup: 'destroyed' };
    try {
    const payload = JSON.stringify({ ...this.publicRecord(), context: {
      prompt: r.prompt, policy_sha256: await digest(JSON.stringify(this.executionPolicy())),
      harness: 'opencode@1.18.34', model: this.admittedModel(),
    } });
    for (const secret of [this.env.GOLF_PROBE_TOKEN, this.credential(r.role, 'read'), this.credential(r.role, 'write')]) {
      if (secret && payload.includes(secret)) throw new Error('credential screening failed');
    }
    const key = `cf-agent/${this.env.GOLF_NAMESPACE}/${r.role}/result.json`;
    const hash = await digest(payload);
    const wrote = await this.env.EVIDENCE.put(key, payload, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256: hash } });
    if (!wrote) {
      const existing = await this.env.EVIDENCE.get(key);
      if (!existing || await digest(await existing.text()) !== hash) throw new Error('immutable result conflict');
    }
    this.record = { ...this.record, evidence: { key, sha256: hash } };
    } catch {
      this.record = { ...this.record, state: 'lost', evidence: { state: 'failed' } };
    }
  }
  async advice() {
    const previous = this.ctx.storage.kv.get('advice');
    if (previous) return previous;
    this.ctx.storage.kv.put('advice', { state: 'reserved', advisory_only: true });
    try {
      const result = await this.env.AI.run('@cf/cloudflare/clef', {
        model: 'clef', state: 'Two independent agents propose overlapping arithmetic fixes. One proposal passes only its targeted test; the other passes the full suite.',
        questions: { route: { type: 'choice', instructions: 'Choose the next review step.', criteria: {
          integrate_and_retest: 'Resolve the overlap into a new candidate and run its full tests.',
          reuse_prior_checks: 'Promote the combined candidate using the prior proposal checks.',
        } } },
      }, { gateway: { id: this.env.GOLF_GATEWAY, skipCache: true, collectLog: false } });
      if (!result.answers?.route || JSON.stringify(result).length > 16384) throw new Error('invalid advice');
      const safe = { state: 'completed', advisory_only: true, model: '@cf/cloudflare/clef', answers: result.answers, usage: result.usage };
      this.ctx.storage.kv.put('advice', safe);
      return safe;
    } catch {
      const failed = { state: 'unavailable', advisory_only: true };
      this.ctx.storage.kv.put('advice', failed);
      return failed;
    }
  }
  publicRecord() {
    const r = this.record;
    if (!r) return { state: 'none' };
    const { prompt, ...safe } = r;
    return safe;
  }
  async status() {
    const r = this.publicRecord();
    const failure = this.ctx.storage.kv.get('container_failure');
    if (failure) r.container_failure = failure;
    // Publication is incomplete until both execution cleanup and evidence finish.
    return terminal.has(r.state) && r.state !== 'lost' && !r.evidence ? { ...r, state: 'finalizing' } : r;
  }
  async cancel() {
    const r = this.record;
    if (!r) return { state: 'none' };
    if (!terminal.has(r.state)) await this.finish(r.stage === 'publish' ? 'lost' : 'cancelled',
      r.stage === 'publish' ? { publication: 'unknown' } : {});
    else await this.container.destroy();
    return this.publicRecord();
  }
  async alarm() {
    const r = this.record;
    if (!r || terminal.has(r.state)) return;
    try {
      if (r.state === 'preparing' && r.stage === 'admitted') await this.prepare();
      else if (r.state === 'running') await this.observe();
      else await this.finish('lost');
    } catch (error) { await this.finish('lost', { failure: diagnostic(error, this.env) }); }
  }
  async outbound(request) {
    const r = this.record;
    if (!r || terminal.has(r.state)) return reply({ state: 'denied' }, 403);
    if (gitOperation(request, this.remote(r.role), r.stage)) {
      const headers = new Headers(request.headers);
      for (const name of ['Cookie', 'Authorization', 'Host', 'Proxy-Authorization']) headers.delete(name);
      const token = this.credential(r.role, r.stage === 'publish' ? 'write' : 'read');
      if (typeof token !== 'string' || token.length < 32 || token.length > 2048 || /[^\x21-\x7e]/.test(token)) return reply({ state: 'unavailable' }, 503);
      headers.set('Authorization', 'Bearer ' + token);
      return fetch(new Request(request, { headers, redirect: 'manual' }));
    }
    if (r.stage === 'agent' && inference(request)) {
      if (r.calls >= maxCalls || Date.now() >= r.deadline) return reply({ error: { message: 'Task inference budget exhausted' } }, 429);
      const body = JSON.parse(await boundedBody(request, maxBody));
      if (!Array.isArray(body.messages) || body.messages.length > 128 || (body.tools && (!Array.isArray(body.tools) || body.tools.length > 16))) return reply({ error: { message: 'Invalid inference request' } }, 400);
      // Reserve before dispatch, including failed/ambiguous calls. No refund/retry.
      const current = this.record;
      if (!current || current.stage !== 'agent' || terminal.has(current.state) || current.calls >= maxCalls || Date.now() >= current.deadline) {
        return reply({ error: { message: 'Task inference no longer admitted' } }, 429);
      }
      this.record = { ...current, calls: current.calls + 1,
        ...(current.calls === 0 ? { first_inference_at: Date.now() } : {}) };
      try {
        // The proxy forces the admitted model whatever the harness asked for.
        const chosen = this.admittedModel();
        const result = await this.env.AI.run(chosen, { ...body, model: chosen, max_tokens: maxOutput, max_completion_tokens: maxOutput },
          { gateway: { id: this.env.GOLF_GATEWAY, skipCache: true, collectLog: false } });
        return result instanceof ReadableStream ? new Response(openAIStream(result), { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json(result);
      } catch (error) {
        if (!terminal.has(this.record.state)) this.record = { ...this.record, inference_failure: diagnostic(error, this.env) };
        return reply({ error: { message: 'Task inference unavailable' } }, 502);
      }
    }
    this.record = { ...this.record, denied: r.denied + 1 };
    return reply({ state: 'denied' }, 403);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!await authorized(request, env.GOLF_PROBE_TOKEN)) return reply({ state: 'denied' }, 401);
    const u = new URL(request.url);
    if (u.protocol !== 'https:' || u.search) return reply({ state: 'not_found' }, 404);
    if (u.pathname === '/inspect' && request.method === 'GET') return reply({ schema_version: 'golf.cloudflare.agent-runtime.v1', state: 'configured' });
    if (u.pathname === '/advice' && request.method === 'POST') return reply(await ctx.exports.AgentTask.getByName('agent-a').advice());
    const route = /^\/tasks\/(agent-a|agent-b|cancel|timeout|integration)(\/cancel)?$/.exec(u.pathname);
    if (!route) return reply({ state: 'not_found' }, 404);
    const task = ctx.exports.AgentTask.getByName(route[1]);
    try {
      if (request.method === 'GET' && !route[2]) return reply(await task.status());
      if (request.method === 'POST' && route[2]) return reply(await task.cancel());
      if (request.method === 'POST' && !route[2]) {
        const result = await task.create(route[1], JSON.parse(await boundedBody(request, 18000)));
        return reply(result, result.state === 'conflict' ? 409 : 202);
      }
      return reply({ state: 'method_not_allowed' }, 405);
    } catch (error) { return reply({ state: 'unavailable', diagnostic: diagnostic(error, env) }, 503); }
  },
};
