import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Files } from '@cloudflare/sandbox';
import { digest, uuidOK } from './common.mjs';
import { bounded, sha, validRef } from './git.mjs';
import { executionDiagnostic, nativeTestContract, testModuleOK, testTerminal } from './test-policy.mjs';
import { nativeWorkflowContract, nativeWorkflowPath, nativeWorkflowPlanOK } from './native-workflow.mjs';

const trust = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/auth',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false',
  GIT_SSL_CAINFO: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
  SSL_CERT_FILE: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' };

export class TestOutbound extends WorkerEntrypoint {
  fetch(request) {
    const id = this.ctx.props?.jobId;
    if (!uuidOK(id)) return new Response('denied', { status: 403 });
    return this.ctx.exports.PRTestTask.getByName(id).outbound(request);
  }
}

export class PRTestTask extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.container = ctx.container;
    if (!this.container) throw Error('Test container unavailable');
    this.files = new Files(this.container);
    if (this.container.running) ctx.blockConcurrencyWhile(() => this.container.setInactivityTimeout(30000));
  }
  get record() { return this.ctx.storage.kv.get('test'); }
  set record(value) { this.ctx.storage.kv.put('test', value); }
  owner() { return this.ctx.exports.Workspace.getByName(this.env.WORKSPACE_SLUG); }
  async create(input) {
    const workflow = input?.contract === nativeWorkflowContract;
    if (!input || input.contract !== undefined && ![nativeTestContract, nativeWorkflowContract].includes(input.contract) ||
        Object.keys(input).some(key => !(workflow ? ['contract', 'jobId', 'commitId', 'treeId', 'branch', 'workflow', 'workflowSha256', 'policySha256', 'remote', 'deadline', 'registry'] :
          ['contract', 'jobId', 'commitId', 'treeId', 'branch', 'module', 'policySha256', 'remote', 'deadline', 'registry']).includes(key)) ||
        !uuidOK(input.jobId) || !sha(input.commitId) || !sha(input.treeId) || typeof input.branch !== 'string' || !validRef('refs/heads/' + input.branch) ||
        (workflow ? !input.workflow || Object.keys(input.workflow).some(key => !['path', 'blobId', 'plan'].includes(key)) ||
          !nativeWorkflowPath(input.workflow.plan?.format, input.workflow.path) || !sha(input.workflow.blobId) || !nativeWorkflowPlanOK(input.workflow.plan) ||
          !/^[a-f0-9]{64}$/.test(input.workflowSha256 || '') || input.workflowSha256 !== await digest(JSON.stringify(input.workflow)) : !testModuleOK(input.module)) ||
        !/^[a-f0-9]{64}$/.test(input.policySha256 || '') || !Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline > Date.now() + 600000 ||
        typeof input.remote !== 'string' || !/^https:\/\/[a-f0-9]{32}\.artifacts\.cloudflare\.net\/git\/[a-z0-9-]{3,63}\/repo-[a-f0-9]{32}\.git$/.test(input.remote)) throw Error('Invalid test admission');
    if(input.registry && (typeof input.registry !== 'object' || Array.isArray(input.registry) || Object.keys(input.registry).some(key=>!['origin','name'].includes(key)) || this.env.REGISTRY_CI_ENABLED!=='true' || input.registry.origin!==this.env.REGISTRY_ORIGIN || !new RegExp('^'+this.env.WORKSPACE_SLUG+'/[a-z0-9][a-z0-9._-]{0,99}$').test(input.registry.name))) throw Error('Invalid registry admission');
    const hash = await digest(JSON.stringify(input));
    // One task ID admits one process; an uncertain dispatch never starts it again.
    if (this.record) {
      if (this.record.hash !== hash) throw Error('Test identity conflict');
      return this.status();
    }
    this.record = { ...input, hash, state: 'ADMITTED', stage: 'admitted', deniedRequests: 0 };
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return this.status();
  }
  async checked(args, cwd = '/workspace/repo') {
    const process = await this.container.exec(args, { cwd, env: trust, user: '1000:1000' });
    const out = await process.output();
    if (out.stdout.byteLength + out.stderr.byteLength > 65536) throw Error('Trusted preparation output exceeds bound');
    if (out.exitCode !== 0) throw Error('Trusted preparation failed: ' + new TextDecoder('utf-8', { fatal: true }).decode(out.stderr).slice(0, 512));
    return new TextDecoder('utf-8', { fatal: true }).decode(out.stdout).trim();
  }
  phase(stage) {
    if (this.record.state !== 'RUNNING') throw Error('Test no longer running');
    this.record = { ...this.record, stage };
  }
  async prepare() {
    const r = this.record;
    if ((await this.owner().evidence(r.jobId, 'authorize-test')).state !== 'AUTHORIZED') return this.finish('CANCELLED');
    if (this.record.state !== 'ADMITTED') return;
    this.record = { ...this.record, state: 'RUNNING', stage: 'dispatch' };
    const broker = this.ctx.exports.TestOutbound({ props: { jobId: r.jobId } });
    await this.container.interceptAllOutboundHttp(broker);
    await this.container.interceptOutboundHttps('*', broker);
    this.phase('start');
    this.container.start({ image: this.container.images.agent, instance: 'standard-1', entrypoint: ['sleep', 'infinity'], enableInternet: false });
    this.ctx.waitUntil(this.container.monitor().catch(() => {}));
    await this.checked(['/bin/true'], '/workspace');
    await this.container.setInactivityTimeout(30000);
    this.phase('clone');
    await this.checked(['timeout', '--signal=TERM', '--kill-after=5s', '60s', 'git', 'clone', '--depth', '1', '--branch', r.branch, '--', r.remote, '/workspace/repo'], '/workspace');
    const head = await this.checked(['git', 'rev-parse', 'HEAD']), tree = await this.checked(['git', 'rev-parse', 'HEAD^{tree}']);
    if (head !== r.commitId || tree !== r.treeId) throw Error('Selected source moved');
    if (r.contract === nativeWorkflowContract && await this.checked(['git', 'rev-parse', 'HEAD:' + r.workflow.path]) !== r.workflow.blobId) throw Error('Selected workflow moved');
    if ((await this.owner().evidence(r.jobId, 'authorize-test')).state !== 'AUTHORIZED') return this.finish('CANCELLED');
    this.phase('test');
    const environment = { ...trust, ...(r.registry?{GOLF_REGISTRY:r.registry.origin,GOLF_IMAGE:r.registry.name+':ci-'+r.jobId,GOLF_COMMIT:r.commitId}:{}) };
    const run = async (argv, suffix = '', extraEnv = {}) => {
      const seconds = Math.min(60, Math.ceil((r.deadline - Date.now()) / 1000));
      if (seconds <= 0) return { exitCode: 124, stdout: '', stderr: '' };
      const script = `ulimit -f 32; timeout --signal=TERM --kill-after=5s ${seconds}s "$@" > /workspace/task/stdout${suffix} 2> /workspace/task/stderr${suffix}`;
      const process = await this.container.exec(['/bin/sh', '-c', script, 'golf-test', ...argv], { cwd: '/workspace/repo', env: { ...environment, ...extraEnv }, user: '1000:1000' });
      const output = await process.output();
      const read = async path => new TextDecoder('utf-8', { fatal: true }).decode(await bounded((await this.files.readFile(path + suffix)).body, 32768));
      return { exitCode: output.exitCode, stdout: await read('/workspace/task/stdout'), stderr: await read('/workspace/task/stderr') };
    };
    let output;
    if (r.contract === nativeWorkflowContract) {
      const logs = { stdout: '', stderr: '' };
      for (let i = 0; i < r.workflow.plan.steps.length; i++) {
        if (this.record.stage !== 'test') return;
        if (Date.now() >= r.deadline) return this.finish('TIMED_OUT');
        if ((await this.owner().evidence(r.jobId, 'authorize-test')).state !== 'AUTHORIZED') return this.finish('CANCELLED');
        const step = r.workflow.plan.steps[i];
        const argv = step.shell === 'sh' ? ['/bin/sh', '-e', '-c', step.run] : step.shell === 'bash' ? ['/bin/bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run] : ['/bin/bash', '-e', '-c', step.run];
        output = await run(argv, String(i));
        logs.stdout += output.stdout; logs.stderr += output.stderr;
        if (new TextEncoder().encode(logs.stdout + logs.stderr).length > 65536) throw Error('Native workflow log limit');
        if (output.exitCode !== 0) break;
      }
      if (r.workflow.plan.afterScript && output?.exitCode !== 124 && output?.exitCode !== 137) {
        if (this.record.stage !== 'test') return;
        if (Date.now() >= r.deadline) return this.finish('TIMED_OUT');
        if ((await this.owner().evidence(r.jobId, 'authorize-test')).state !== 'AUTHORIZED') return this.finish('CANCELLED');
        const after = await run(['/bin/sh', '-e', '-c', r.workflow.plan.afterScript], 'after', { CI_JOB_STATUS: output.exitCode === 0 ? 'success' : 'failed' });
        logs.stdout += after.stdout; logs.stderr += after.stderr;
        if (new TextEncoder().encode(logs.stdout + logs.stderr).length > 65536) throw Error('Native workflow log limit');
        if (Date.now() >= r.deadline) return this.finish('TIMED_OUT');
      }
      output = { ...output, ...logs };
    } else output = await run(['python3', '-m', 'unittest', '-v', r.module]);
    if (this.record.stage !== 'test') return;
    let image;
    if(output.exitCode===0 && r.registry) {
      const tag='ci-'+r.jobId, response=await this.owner().testRegistry(r.jobId,new Request(r.registry.origin+'/v2/'+r.registry.name+'/manifests/'+tag));
      if(response.status!==404) {
        if(!response.ok) throw Error('Registry publication readback unavailable');
        const bytes=await bounded(response.body,1024*1024), hash='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
        if(response.headers.get('Docker-Content-Digest')!==hash) throw Error('Registry publication digest differs');
        image={registry:r.registry.origin,repository:r.registry.name,tag,digest:hash,commitId:r.commitId};
      }
    }
    await this.finish([124, 137].includes(output.exitCode) ? 'TIMED_OUT' : output.exitCode === 0 ? 'PASSED' : 'FAILED',
      { exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr, ...(image?{image}:{}) });
  }
  async finish(state, output = {}) {
    const r = this.record;
    if (!r) return { state: 'ABSENT' };
    if (testTerminal.has(r.state) && r.cleanup === 'destroyed') return this.status();
    // Destruction interrupts in-flight preparation; its error must not replace the first terminal result.
    if (this.finishing) return this.finishing;
    if (!testTerminal.has(r.state)) this.record = { ...r, state, stage: 'terminal', failureStage: r.stage, exitCode: null, stdout: '', stderr: '', finishedAt: Date.now(), ...output };
    this.finishing = (async () => {
      await this.ctx.storage.deleteAlarm();
      try {
        await this.container.destroy();
        this.record = { ...this.record, cleanup: 'destroyed' };
      } catch { this.record = { ...this.record, cleanup: 'failed' }; throw Error('Test container cleanup unconfirmed'); }
      return this.status();
    })();
    try { return await this.finishing; } finally { this.finishing = null; }
  }
  status() {
    const r = this.record;
    if (!r) return { state: 'ABSENT' };
    return { ...(r.contract ? { contract: r.contract } : {}), jobId: r.jobId, commitId: r.commitId, treeId: r.treeId,
      ...(r.contract === nativeWorkflowContract ? { workflowSha256: r.workflowSha256 } : { module: r.module }), policySha256: r.policySha256,
      state: r.cleanup === 'failed' ? 'CLEANUP_FAILED' : testTerminal.has(r.state) && !r.cleanup ? 'FINALIZING' : r.state,
      cleanup: r.cleanup, deniedRequests: r.deniedRequests, exitCode: r.exitCode, stdout: r.stdout || '', stderr: r.stderr || '', finishedAt: r.finishedAt,
      ...(r.image && r.state==='PASSED' && r.cleanup==='destroyed'?{image:r.image}:{}),
      ...(r.state === 'LOST' ? { failureStage: r.failureStage, diagnostic: r.diagnostic || '' } : {}) };
  }
  cancel() { return this.finish('CANCELLED'); }
  async alarm() {
    if (!this.record || testTerminal.has(this.record.state) && this.record.cleanup === 'destroyed') return;
    try {
      if (Date.now() >= this.record.deadline) return await this.finish('TIMED_OUT');
      if (this.record.state !== 'ADMITTED') return await this.finish('LOST');
      await this.prepare();
    } catch (error) {
      const diagnostic = executionDiagnostic(error);
      await this.finish('LOST', { diagnostic });
    }
  }
  async outbound(request) {
    const r = this.record;
    if (r?.state === 'RUNNING' && r.stage === 'test' && r.registry && Date.now() < r.deadline && this.env.REGISTRY_CI_ENABLED === 'true' && new URL(request.url).origin === r.registry.origin) {
      try {
        const response = await this.owner().testRegistry(r.jobId, request);
        if (response.status === 503 && response.headers.get('X-Golf-Registry-Broker-Error') === '1') throw Error(new TextDecoder().decode(await bounded(response.body,2048)));
        return response;
      }
      catch (error) {
        await this.finish('LOST', { diagnostic: executionDiagnostic(error) });
        return new Response('Registry broker unavailable', { status: 503 });
      }
    }
    if (!r || r.state !== 'RUNNING' || r.stage !== 'clone' || Date.now() >= r.deadline) {
      if (r?.state === 'RUNNING') this.record = { ...r, deniedRequests: Math.min(1000000, r.deniedRequests + 1) };
      return new Response('denied', { status: 403 });
    }
    // The authority broker accepts only this job's exact upload-pack route.
    return this.owner().testGit(r.jobId, request);
  }
}
