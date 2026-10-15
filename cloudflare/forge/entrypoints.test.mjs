import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';

for (const entry of ['worker', 'test-entry', 'agent-entry']) {
  test(`${entry} ships the authority and runtime exports used by private bindings`, async () => {
    const built = await esbuild.build({
      entryPoints: [fileURLToPath(new URL(`./src/${entry}.mjs`, import.meta.url))],
      bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral',
      nodePaths: [fileURLToPath(new URL('../agents/node_modules', import.meta.url))],
      conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'],
      define: { GOLF_NATIVE_ASSETS: 'null' },
    });
    const exported = Object.values(built.metafile.outputs).flatMap(output => output.exports);
    const expected = ['default', 'Workspace', 'RepositoryReads', 'EvidenceWorkflow', 'AiWorkflow', 'PreviewBroker', 'PackagesAuthority', 'SSHAgentTask'];
    if (entry !== 'worker') expected.push('PRTestTask', 'TestOutbound');
    if (entry === 'agent-entry') expected.push('PRAgentTask', 'AgentOutbound');
    for (const name of expected) assert.ok(exported.includes(name), `${entry} missing ${name}`);
  });
}
