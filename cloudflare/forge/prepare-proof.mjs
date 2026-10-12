// Operator-only hosted test: real service RPC under Access plus a separate nonce.
// This synthetic reviewer never qualifies an actual human Access login.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
const root = resolve(process.argv[2]), cli = dirname(dirname(realpathSync(process.argv[3])));
const settings = JSON.parse(await readFile(resolve(root, '../forge.json'), 'utf8'));
const proof = JSON.parse(await readFile(resolve(root, '../preview-proof.json'), 'utf8'));
if (JSON.parse(await readFile(resolve(cli, 'package.json'), 'utf8')).version !== '1.0.0-beta.13' || !/^[a-f0-9]{64}$/.test(proof.digest) ||
    settings.previews.workers_dev !== true && proof.origin !== settings.previews.origin) throw Error('Invalid ephemeral preview proof');
const u = await import(pathToFileURL(resolve(cli, 'node_modules/@cloudflare/build-output-utils/dist/index.mjs')).href);
const output = await u.readBuildOutput(root), config = output.workers.default.config;
config.env.QUALIFICATION_TOKEN_SHA256 = { type: 'text', value: proof.digest };
const contents = `import gateway from './src/preview-gateway.mjs';
import { digest } from './src/common.mjs';
import { bounded } from './src/git.mjs';
export default { async fetch(request,env,ctx) {
 if (new URL(request.url).pathname !== '/__qualification') return gateway.fetch(request,env,ctx);
 try {
  if (request.method !== 'POST' || ctx.access?.aud !== env.ACCESS_AUD || await digest(request.headers.get('Authorization') || '') !== env.QUALIFICATION_TOKEN_SHA256) throw Error('denied');
  const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(request.body,2048)));
  if (input.email !== 'bob@example.invalid') throw Error('denied');
  if (Array.isArray(input.body)) input.body=new Uint8Array(input.body);
  const value=await env.FORGE.preview(input);
  return Response.json(value.app?{...value,content:value.content===null?null:Array.from(value.content)}:value,{headers:{'Cache-Control':'no-store'}});
 } catch { return new Response('denied',{status:404,headers:{'Cache-Control':'no-store'}}); }
} };`;
await writeFile(resolve(root, '../preview-proof-entry.txt'), contents);
await esbuild.build({ stdin: { contents, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'preview-proof-entry.mjs' }, outfile: resolve(u.getWorkerBundleDir(root), 'worker.mjs'), bundle: true, format: 'esm', platform: 'neutral' });
await u.writeWorkerConfig({ root, config, manifest: { type: 'partial', mainModule: 'worker.mjs', modules: {} } });
await u.readBuildOutput(root);
console.log('Ephemeral Access-gated preview RPC proof prepared');
