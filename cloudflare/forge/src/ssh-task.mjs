// SSHAgentTask (docs/SSH_HOSTS.md): one Durable Object and one container per SSH host task ("task:<id>") or connection test
// ("probe:<id>"). The container image (cloudflare/ssh-hosts/Dockerfile) holds golf-agent-host, Git, Tailscale and cloudflared; the
// job (the claimed task, the host's address and key, reach secrets) reaches it only on the standard input of `golf-agent-host ssh-run`
// or `ssh-probe`, never its environment or argv. ssh-run reports through the agent host task routes with the task token, exactly as an
// outbound host does; this object only starts the container, calls in for the host while the task runs (the LOST sweep reads that),
// stops the container when the task ends, is cancelled or passes its deadline, and dispatches the host's next queued task.
// Workers VPC reach: the container listens on one TCP port and this object bridges it to env.SSH_VPC_NETWORK.connect().
import { DurableObject } from 'cloudflare:workers';
import { dispatchSSHHost, recordSSHProbe, sshConnectionJob, sshTaskJob, sshTaskStopped, sshTaskTick } from './ssh-hosts.mjs';

export const sshTick = 15_000, cancelGrace = 60_000, probeLimit = 120_000;
const binary = '/usr/local/bin/golf-agent-host';
const input = value => new Response(JSON.stringify(value)).body;

export class SSHAgentTask extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.container = ctx.container;
  }
  get record() { return this.ctx.storage.kv.get('ssh'); }
  set record(value) { this.ctx.storage.kv.put('ssh', value); }
  db() { return this.env.DB.withSession('first-primary'); }
  // The configuration dispatch needs: the same bindings, and this class as the dispatcher.
  configured() { return { ...this.env, sshTasks: this.ctx.exports.SSHAgentTask }; }

  // Called by dispatchSSHHost right after the claim; the token is kept only until the container has it.
  async run({ taskId, hostId, token }) {
    if (this.record) return { state: this.record.stage };
    this.record = { kind: 'task', taskId, hostId, token, stage: 'dispatched', at: Date.now() };
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return { state: 'dispatched' };
  }
  async probe({ probeId, hostId }) {
    if (this.record) return { state: this.record.stage };
    this.record = { kind: 'probe', probeId, hostId, stage: 'dispatched', at: Date.now() };
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return { state: 'dispatched' };
  }
  async cancel() {
    if (this.record && this.record.stage !== 'done') await this.done();
    return { state: this.record?.stage || 'none' };
  }

  async alarm() {
    const r = this.record;
    if (!r || r.stage === 'done') return;
    if (r.kind === 'probe') return this.runProbe(r);
    try {
      if (r.stage === 'dispatched') await this.launch(r);
      else await this.watch(r);
    } catch (error) {
      console.log(JSON.stringify({ event: 'golf.ssh_task_failed', stage: r.stage, message: String(error?.message || error).slice(0, 200) }));
      await sshTaskStopped(this.db(), r.taskId, 'LOST', 'ssh_runner_lost');
      await this.done();
      await this.next(r);
    }
  }

  async start() {
    if (!this.container) throw Error('This Durable Object has no container');
    if (!this.container.running) this.container.start({ image: this.container.images.ssh, instance: 'standard-1', entrypoint: ['sleep', 'infinity'], enableInternet: true });
    this.ctx.waitUntil(this.container.monitor().catch(() => {}));
    // start() returns before the container accepts commands.
    for (let attempt = 0; ; attempt++) {
      try { const ready = await this.container.exec(['/bin/true'], { stdout: 'ignore', stderr: 'ignore' }); if (await ready.exitCode === 0) return; }
      catch (error) { if (attempt >= 30) throw error; }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async launch(r) {
    const db = this.db();
    let job;
    try { job = await sshTaskJob(db, this.env, r.taskId, r.token); }
    catch { await sshTaskStopped(db, r.taskId, 'FAILED', 'ssh_dispatch_failed'); await this.done(); await this.next(r); return; }
    await this.start();
    await this.container.exec([binary, 'ssh-run'], { stdin: input(job), stdout: 'ignore', stderr: 'ignore' });
    const { token, ...rest } = r;
    this.record = { ...rest, stage: 'running', launchedAt: Date.now() };
    if (job.ssh.reach === 'workers-vpc') this.ctx.waitUntil(this.bridge(job.ssh).catch(() => {}));
    await this.ctx.storage.setAlarm(Date.now() + sshTick);
  }

  async watch(r) {
    const db = this.db(), tick = await sshTaskTick(db, r.taskId);
    if (tick.terminal) { await this.done(); await this.next(r); return; }
    if (!this.container?.running) { await sshTaskStopped(db, r.taskId, 'LOST', 'ssh_runner_lost'); await this.done(); await this.next(r); return; }
    // ssh-run sees a cancel within seconds and finishes the task itself after stopping the tool and removing the remote working copy.
    if (tick.cancel && !r.cancelSeenAt) this.record = { ...r, cancelSeenAt: Date.now() };
    else if (tick.cancel && Date.now() - r.cancelSeenAt > cancelGrace) { await this.done(); await sshTaskStopped(db, r.taskId, 'CANCELLED', 'cancelled'); await this.next(r); return; }
    if (Date.now() > tick.deadline + cancelGrace) { await this.done(); await sshTaskStopped(db, r.taskId, 'TIMED_OUT', 'timed_out'); await this.next(r); return; }
    await this.ctx.storage.setAlarm(Date.now() + sshTick);
  }

  async runProbe(r) {
    const db = this.db();
    let result;
    try {
      const ssh = await sshConnectionJob(db, this.env, r.hostId);
      await this.start();
      const process = await this.container.exec([binary, 'ssh-probe'], { stdin: input({ ssh }), stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(probeLimit) });
      if (ssh.reach === 'workers-vpc') this.ctx.waitUntil(this.bridge(ssh).catch(() => {}));
      const output = await process.output();
      if (output.stdout.byteLength > 256 * 1024) throw Error('The connection test reported too much');
      result = JSON.parse(new TextDecoder().decode(output.stdout) || '{}');
    } catch (error) {
      result = { authenticated: false, error: `The connection test did not complete: ${String(error?.message || error).slice(0, 200)}` };
    }
    await recordSSHProbe(db, this.env, r.hostId, r.probeId, result);
    await this.done();
  }

  // Workers VPC: the container's listener (it starts listening after it reads its job) to the private address through the VPC network.
  // The container's TCP port reports a connection opened even before anything listens on it, so the bridge first waits until the
  // kernel shows a listening socket on that port; a connection made earlier is dropped and the tunnel side closes with it.
  async bridge(ssh) {
    const port = ssh.vpc.listenPort, hex = port.toString(16).toUpperCase().padStart(4, '0');
    const listening = async () => {
      const check = await this.container.exec(['/bin/sh', '-c', `grep -qE '^ *[0-9]+: [0-9A-F]+:${hex} [0-9A-F]+:[0-9A-F]+ 0A ' /proc/net/tcp /proc/net/tcp6`], { stdout: 'ignore', stderr: 'ignore' });
      return await check.exitCode === 0;
    };
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      try { ready = await listening(); } catch { /* the container is still starting the process */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw Error('The container did not listen for the VPC bridge');
    const inner = this.container.getTcpPort(port).connect(`10.0.0.1:${port}`);
    await inner.opened;
    const outer = this.env.SSH_VPC_NETWORK.connect(`${ssh.address.includes(':') ? `[${ssh.address}]` : ssh.address}:${ssh.port}`);
    await outer.opened;
    await Promise.allSettled([inner.readable.pipeTo(outer.writable), outer.readable.pipeTo(inner.writable)]);
  }

  async done() {
    const r = this.record;
    this.record = { ...r, token: undefined, stage: 'done', doneAt: Date.now() };
    await this.ctx.storage.deleteAlarm();
    try { if (this.container?.running) await this.container.destroy(); } catch { /* the inactivity timeout stops it */ }
  }
  // The host's next queued task, now that this one no longer counts against its concurrency.
  async next(r) {
    try { await dispatchSSHHost(this.db(), this.configured(), r.hostId); } catch { /* the maintenance sweep dispatches it */ }
  }
}
