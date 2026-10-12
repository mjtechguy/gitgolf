// Actual workerd/D1 adapter transactions; only the Artifacts read boundary is a fixture.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {packetLine} from './src/git.mjs';
import {digest} from './src/common.mjs';
import * as esbuild from '../agents/node_modules/esbuild/lib/main.js';
const cli=dirname(dirname(realpathSync(process.argv[2])));
if(JSON.parse(await readFile(resolve(cli,'package.json'),'utf8')).version!=='1.0.0-beta.13')throw Error('Qualify native CLI');
const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(resolve(cli,'node_modules/miniflare/dist/src/index.js')).href);
const bundle=await esbuild.build({stdin:{resolveDir:resolve('cloudflare/forge'),sourcefile:'review-runtime-fixture.mjs',contents:`
import {handle} from './src/core.mjs';
import {remote} from './src/git.mjs';
export default {fetch(request,env) {
 const fixture={...env,ARTIFACTS:{async get(name){return {async info(){return {name,remote:remote(env,name)};},async createToken(){return {plaintext:'local-only-read-token'};},async revokeToken(){return true;},[Symbol.dispose](){}};}}};
 return handle(request,fixture);
}};`},bundle:true,write:false,format:'esm',platform:'neutral'});
const base='a'.repeat(40),head='b'.repeat(40),origin='https://golf.example.com';
const advert=Buffer.concat([packetLine('# service=git-upload-pack\n'),Buffer.from('0000'),packetLine(base+' refs/heads/main\0report-status\n'),packetLine(head+' refs/heads/feature\n'),Buffer.from('0000')]);
const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-08',d1Databases:{DB:'reviews'},
 bindings:{PUBLIC_ORIGIN:origin,WORKSPACE_SLUG:'alice',ARTIFACTS_NAMESPACE:'review-proof',ACCOUNT_ID:'a'.repeat(32)},
 outboundService:async request=>{assert.equal(request.method,'GET');assert.ok(new URL(request.url).pathname.endsWith('/info/refs'));return new Response(advert,{headers:{'Content-Type':'application/x-git-upload-pack-advertisement'}});}}));
try {
 const db=await runtime.getD1Database('DB');
 for(const sql of (await readFile(new URL('./schema.sql',import.meta.url),'utf8')).replace(/--[^\n]*/g,'').split(/;\s*(?=CREATE\b)/).filter(s=>s.trim()))await db.prepare(sql).run();
 await db.prepare("INSERT INTO users(id,login,email) VALUES(1,'alice','alice@example.com'),(2,'bob','bob@example.com')").run();
 await db.prepare("INSERT INTO workspaces(slug,artifact_namespace) VALUES('alice','review-proof')").run();
 await db.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','repo-11111111111111111111111111111111',1,'original','hash','ACTIVE','2026-10-11T00:00:00Z')").run();
 await db.prepare("INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read')").run();
 await db.prepare("INSERT INTO discussions(id,repository_id,number,kind,author_id,title,body,state,created_at,updated_at) VALUES(1,1,1,'pull',1,'PR','','OPEN','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')").run();
 await db.prepare("INSERT INTO pull_requests(id,discussion_id,base_branch,head_branch,base_commit,head_commit,draft) VALUES(1,1,'main','feature',?,?,0)").bind(base,head).run();
 const target={repository:{owner:'alice',name:'project'},repositoryId:'1',pullRequestId:'1',number:1};
 const rpc=async(service,method,body={},person='alice')=>{
  const response=await runtime.dispatchFetch(origin+'/rpc/golf.v1.'+service+'/'+method,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1','X-Golf-Native-Access-Email':person+'@example.com',Origin:origin},body:JSON.stringify(body)});
  assert.equal(response.status,200,await response.clone().text());return response.json();
 };
 const request=(method,body={})=>rpc('PullReviewRequestService',method,{...target,...body});
 const author=(method,body={})=>rpc('PullReviewAuthoringService',method,{target,...body},'bob');
 const before=await request('GetPullReviewRequests');
 const input={operationId:crypto.randomUUID(),expectedPullRevision:before.pullRevision,expectedRequestsRevision:before.requestsRevision,reviewerId:'2',reviewerLogin:'bob',requestReview:true};
 const assigned=await request('SubmitPullReviewRequest',input);assert.equal(assigned.operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.deepEqual(await request('SubmitPullReviewRequest',input),assigned);
 const empty=await author('GetPullReviewAuthoringState');
 const draft={kind:1,operationId:crypto.randomUUID(),expectedPullRevision:empty.pullRevision,expectedSnapshotRevision:empty.snapshotRevision,body:'Private runtime summary',bodyHash:await digest('Private runtime summary')};
 const created=await author('SubmitPullReviewAuthoringOperation',draft);assert.equal(created.operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.equal((await rpc('RepositoryService','ListPullRequestReviews',target)).reviews.length,0);
 const pending=await author('GetPullReviewAuthoringState');assert.equal(pending.review.body,draft.body);
 const submit={kind:4,reviewId:pending.review.id,reviewCommitId:head,operationId:crypto.randomUUID(),expectedPullRevision:pending.pullRevision,expectedSnapshotRevision:pending.snapshotRevision,body:'Ready',bodyHash:await digest('Ready'),decision:1};
 const published=await author('SubmitPullReviewAuthoringOperation',submit);assert.equal(published.operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.equal((await rpc('RepositoryService','ListPullRequestReviews',target)).reviews[0].state,'PULL_REQUEST_REVIEW_STATE_APPROVED');
 assert.equal((await request('GetPullReviewRequests')).reviewers.length,0);
 const selection={reviewId:pending.review.id,reviewCommitId:head},lifecycle=await request('GetPullReviewLifecycleState',selection);
 const dismiss={...selection,operationId:crypto.randomUUID(),expectedPullRevision:lifecycle.pullRevision,expectedReviewRevision:lifecycle.reviewRevision,dismiss:true,reason:'Revise',reasonHash:await digest('Revise')};
 assert.equal((await request('SubmitPullReviewLifecycle',dismiss)).operation.phase,'DISCUSSION_RESOURCE_OPERATION_PHASE_SUCCEEDED');
 assert.equal((await rpc('RepositoryService','ListPullRequestReviews',target)).reviews[0].dismissed,true);
 assert.equal((await author('GetPullReviewAuthoringOperation',{operationId:draft.operationId})).operation.observedReviewId,pending.review.id);
 assert.equal((await db.prepare("SELECT count(*) n FROM discussion_events WHERE kind='review_approved'").first()).n,1);
 const settings=(await rpc('RepositorySettingsService','GetRepositorySettings',target)).settings;
 const changed=(await rpc('RepositorySettingsService','UpdateRepositorySettings',{repository:target.repository,repositoryId:target.repositoryId,ownerId:settings.ownerId,expectedRevision:settings.revision,defaultBranch:'feature'})).settings;
 assert.equal(changed.defaultBranch,'feature');
 assert.equal((await db.prepare('SELECT default_branch FROM repositories').first()).default_branch,'feature');
 console.log('Real workerd/D1 review assignment, notification, private draft, publication, dismissal and receipt replay passed');
} finally {await runtime.dispose();}
