import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=resolve(process.argv[2]);
const cliRoot=dirname(dirname(realpathSync(process.argv[3])));
if(JSON.parse(await readFile(resolve(cliRoot,'package.json'),'utf8')).version!=='1.0.0-beta.13')throw new Error('Qualify the installed native cf build format');
const state=JSON.parse(await readFile(resolve(root,'ownership.json'),'utf8'));
if(process.argv[4]==='domains'||process.argv[4]==='remove-domain'){
 const oauth=await import(pathToFileURL(resolve(cliRoot,'dist/oauth-Bj5Ne1o8.mjs')).href);
 const auth=await import(pathToFileURL(resolve(cliRoot,'dist/auth-CGLsxbc6.mjs')).href);
 oauth.p(state.profile);const client=await auth.n({});const options={timeoutInSeconds:20,maxRetries:0};
 if(process.argv[4]==='domains'){
  const response=await client.workers.domains.list({account_id:state.account},options);process.stdout.write(JSON.stringify(response ?? null));
 }else{
  const domain=state.resources.domain;if(!domain||domain.hostname!==state.hostname||domain.zone_id!==state.zone||domain.service!==state.resources.worker)throw new Error('Original domain ownership unavailable');
  const current=await client.workers.domains.get({account_id:state.account,domain_id:domain.id},options);
  if(current.hostname!==domain.hostname||current.service!==domain.service||current.zone_id!==domain.zone_id)throw new Error('Domain ownership changed');
  const response=await client.workers.domains.delete({account_id:state.account,domain_id:domain.id},options);process.stdout.write(JSON.stringify(response ?? null));
 }
 process.exit(0);
}
const u=await import(pathToFileURL(resolve(cliRoot,'node_modules/@cloudflare/build-output-utils/dist/index.mjs')).href);
const s=state;const prepared=JSON.parse(await readFile(resolve(root,'prepared.json'),'utf8'));
const env={PREVIEW_DB:{type:'d1',id:s.resources.d1.uuid,name:s.resources.d1.name},PREVIEW_R2:{type:'r2',name:s.resources.r2.name},GOLF_BROKER_SECRET:{type:'secret'}};
const vars={GOLF_ORIGIN:s.origin,PREVIEW_ORIGIN:prepared.preview,DEPLOYMENT_ID:prepared.deployment,ACCESS_AUD:s.resources.application.aud,TARGET_FINGERPRINT:prepared.fingerprint,ARCHIVE_SHA256:prepared.archive,COMMIT_ID:prepared.commit,D1_ID:s.resources.d1.uuid,R2_BUCKET:s.resources.r2.name};
for(const [name,value] of Object.entries(vars))env[name]={type:'text',value};
await u.writeRootConfig(root,{accountId:s.account},{isPreview:false});
const bundle=u.getWorkerBundleDir(root);await mkdir(bundle,{recursive:true});
await copyFile(fileURLToPath(new URL('./src/worker.mjs',import.meta.url)),resolve(bundle,'worker.mjs'));
await u.writeWorkerConfig({root,config:{name:s.resources.worker,compatibilityDate:'2026-10-08',workersDev:false,previewUrls:false,domains:[s.hostname],limits:{cpuMs:100},observability:{enabled:false},env},manifest:{type:'partial',mainModule:'worker.mjs',modules:{}}});
await u.readBuildOutput(root);console.log('Native protected preview build output validated');
