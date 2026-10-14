import { WorkerEntrypoint } from 'cloudflare:workers';
import { AgentTask } from '../../agents/src/worker.mjs';
import { gitOperation, inference } from '../../agents/src/policy.mjs';
import { digest, uuidOK } from './common.mjs';
import { agentInputOK, agentAdmissionOK, agentTerminal } from './agent-policy.mjs';

export class AgentOutbound extends WorkerEntrypoint {
  async fetch(request) {
    const id = this.ctx.props?.jobId;
    if (!uuidOK(id)) return new Response('denied', { status: 403 });
    return this.ctx.exports.PRAgentTask.getByName(id).outbound(request);
  }
}

export class PRAgentTask extends AgentTask {
  constructor(ctx, env) {
    super(ctx, { ...env, GOLF_GATEWAY: env.EVIDENCE_GATEWAY });
  }
  owner() { return this.ctx.exports.Workspace.getByName(this.env.WORKSPACE_SLUG); }
  remote() { return this.record.remote; }
  outboundService(jobId) { return this.ctx.exports.AgentOutbound({ props: { jobId } }); }
  cloneArgs(r) { return ['--single-branch', '--branch', r.branch]; }
  async create(input) {
    if (!agentInputOK(input) || !await agentAdmissionOK(this.env, input)) throw Error('Invalid native agent admission');
    const hash = await digest(JSON.stringify(input));
    if (this.record) {
      if (this.record.input_hash !== hash) throw Error('Native agent admission changed');
      return this.status();
    }
    this.record = { schema_version: 'golf.native.pr-agent.v1', role: input.jobId, state: 'preparing', stage: 'admitted',
      input_hash: hash, prompt: input.prompt, prompt_sha256: await digest(input.prompt),
      base_commit: input.commitId, base_tree: input.treeId, branch: input.branch, remote: input.remote,
      allowed_path: input.allowedPath, policy_sha256: input.policySha256, module: input.module, ...(input.model ? { model: input.model } : {}),
      timeout_ms: 120000, expires_at: input.deadline, created_at: Date.now(), calls: 0, denied: 0, events: [] };
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return this.status();
  }
  async authorize() {
    if (!this.record || agentTerminal.has(this.record.state) || Date.now() >= this.record.expires_at ||
        (await this.owner().evidence(this.record.role, 'authorize-agent')).state !== 'AUTHORIZED') throw Error('Native agent authority ended');
  }
  async tests(r) {
    await this.authorize();
    // A failing proposal is retained for review; its tests never authorize merge.
    return { full: await this.run(['timeout', '--signal=TERM', '--kill-after=5s', '60s', 'python3', '-m', 'unittest', '-v', r.module]) };
  }
  validateProposal(patch, tests) {
    if (new TextEncoder().encode(JSON.stringify([patch, tests, this.record.events])).length > 80 * 1024) throw Error('Native proposal evidence exceeds its limit');
  }
  async finish(state, result = {}) {
    const r = this.record;
    if (!r || agentTerminal.has(r.state) && r.cleanup === 'destroyed') return;
    if (state === 'lost' && r.stage === 'publish') result = { ...result, publication: 'unknown' };
    if (!agentTerminal.has(r.state)) this.record = { ...r, state, stage: 'terminal', terminal_from: r.stage, finished_at: Date.now(), ...result };
    await this.ctx.storage.deleteAlarm();
    try { await this.container.destroy(); this.record = { ...this.record, cleanup: 'destroyed' }; }
    catch { this.record = { ...this.record, state: 'lost', cleanup: 'failed' }; throw Error('Native agent cleanup unconfirmed'); }
  }
  async status() {
    const r = this.publicRecord();
    if (r.state === 'none') return { state: 'ABSENT' };
    if (r.cleanup === 'failed') return { state: 'CLEANUP_FAILED' };
    if (agentTerminal.has(r.state) && r.cleanup !== 'destroyed') return { state: 'FINALIZING' };
    return r;
  }
  async cancel() {
    const r = this.record;
    if (!r) return { state: 'ABSENT' };
    await this.finish(r.stage === 'publish' ? 'lost' : 'cancelled', r.stage === 'publish' ? { publication: 'unknown' } : {});
    return this.status();
  }
  async alarm() {
    if (agentTerminal.has(this.record?.state)) return;
    try { await this.authorize(); await super.alarm(); }
    catch { await this.finish('lost'); }
  }
  async outbound(request) {
    const r = this.record;
    try { await this.authorize(); } catch { return new Response('denied', { status: 403 }); }
    if (gitOperation(request, this.remote(), r.stage)) return this.owner().agentGit(r.role, request, r.stage);
    if (r.stage === 'agent' && inference(request)) return super.outbound(request);
    this.record = { ...this.record, denied: this.record.denied + 1 };
    return new Response('denied', { status: 403 });
  }
}
