import { consumeEvidenceDeadLetters } from './src/evidence.mjs';
import { collectWorkerMetrics, collectServiceHealth, operationsPolicy } from './src/operations-provider.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { handle, digest, concurrentRead } from './src/core.mjs';
import { runMaintenance } from './src/operations.mjs';

async function fixture(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO users(id,login,email,can_create) VALUES(1,'owner','owner@example.invalid',1),(2,'creator','creator@example.invalid',1); INSERT INTO operations_admins(user_id) VALUES(1)");
  let revoke = false;
  const DB = {withSession() {return this},async batch(statements){return Promise.all(statements.map(statement=>statement.all()))},prepare(query) {const s=sql.prepare(query); let args=[];return {
    bind(...values){args=values;return this},async first(){const result=s.get(...args)||null;if(revoke && query.includes('COUNT(*)')){revoke=false;sql.exec('UPDATE operations_admins SET active=0')};return result},
    async all(){const results=s.all(...args);if(revoke && query.includes('COUNT(*)')){revoke=false;sql.exec('UPDATE operations_admins SET active=0')};return {results}},async run(){return {meta:{changes:s.run(...args).changes}}},
  }}};
  const env={DB, PUBLIC_ORIGIN:'https://golf.example.com',WORKSPACE_SLUG:'workspace'};
  const call = (email='owner@example.invalid', headers={}, path='/rpc/golf.v1.OperationsService/GetOperationsDashboard') => handle(new Request(env.PUBLIC_ORIGIN+path,{method:'POST',headers:{'Content-Type':'application/json','Connect-Protocol-Version':'1', ...(email?{'X-Golf-Native-Access-Email':email}:{}),...headers},body:'{}'}),env);
  return {sql,env,call,revokeDuringRead(){revoke=true}};
}

test('native operations require explicitly enrolled current human admin, not repository creator or Git bearer',async t=>{
 const f=await fixture(t);
 assert.equal(concurrentRead(new Request(f.env.PUBLIC_ORIGIN+'/rpc/golf.v1.OperationsService/GetOperationsDashboard',{method:'POST'})),true);
 assert.equal((await f.call('creator@example.invalid')).status,403);
 assert.equal((await f.call('outsider@example.invalid')).status,401);
 assert.equal((await f.call('')).status,401);
 assert.equal((await f.call('owner@example.invalid',{'CF-Access-Client-Id':'service-principal'})).status,403);
 const token='golf_native_'+'a'.repeat(43);
 f.sql.prepare('INSERT INTO credentials VALUES(?,?,?,0)').run(await digest(token),1,Math.floor(Date.now()/1000)+100);
 assert.equal((await f.call('owner@example.invalid',{Authorization:'Bearer '+token})).status,403);
 const access=await (await f.call('owner@example.invalid',{},'/rpc/golf.v1.SessionService/GetSession')).json();assert.equal(access.user.isInstanceAdmin,true);
 const bearer=await (await f.call('',{Authorization:'Bearer '+token},'/rpc/golf.v1.SessionService/GetSession')).json();assert.equal(bearer.user.isInstanceAdmin,false);
 const response=await f.call();assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 const data=await response.json();assert.equal(data.scope,'workspace:workspace');assert.equal(data.metrics.find(m=>m.id==='jobs.queued').value,0);
 assert.equal(data.metrics.find(m=>m.id==='billing.actual').state,'unknown');assert.ok(!Object.hasOwn(data.metrics.find(m=>m.id==='billing.actual'),'value'));
 assert.equal(data.services.find(s=>s.id==='maintenance.previews').state,'unknown');
 const serialized=JSON.stringify(data);assert.ok(!serialized.includes('owner@example.invalid'));assert.ok(!serialized.includes(token));
 f.sql.exec('UPDATE users SET active=0 WHERE id=1');assert.equal((await f.call()).status,401);
});

test('operations withheld on admin revocation during inventory wait',async t=>{
 const f=await fixture(t);f.revokeDuringRead();const response=await f.call();assert.equal(response.status,403);assert.ok(!Object.hasOwn(await response.json(),'metrics'));
});

test('service activity uses successful journals without claiming current health or exposing source',async t=>{
 const f=await fixture(t), stamp=new Date().toISOString();
 Object.assign(f.env,{ACCESS_AUD:'approved',EVIDENCE_QUEUE:{},EVIDENCE_WORKFLOW_NAME:'owned',testTasks:{},EVIDENCE_ALLOW_AI:'true',EVIDENCE_GATEWAY:'owned',APP_POLICY:'owned',PREVIEW_ORIGIN:'https://previews.example.invalid',APP_PROVISIONER:{},BROWSER:{}});
 f.sql.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','PRIVATE SOURCE','owned',1,'key','hash','ACTIVE',?)").run(stamp);
 f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,state,delivery,test_state,report_key,created_at,updated_at,expires_at) VALUES('job',1,1,'key','hash','PRIVATE SOURCE','REQUESTED','QUEUED','STARTED','RUNNING','private/report',?,?,?)").run(stamp,stamp,stamp);
 let data=await(await f.call()).json();assert.equal(data.services.find(row=>row.id==='workflows').state,'configured');
 f.sql.exec("UPDATE evidence_jobs SET state='SUCCEEDED',test_state='PASSED',advice_state='SUCCEEDED'");
 f.sql.prepare("INSERT INTO previews(id,repository_id,user_id,job_id,operation_key,input_hash,selection,pr_revision,commit_id,tree_id,source_path,bundle_key,bundle_hash,bundle_bytes,state,created_at,expires_at,kind,capture_state,capture_hash,capture_bytes) VALUES('preview',1,1,'job','key','hash','PRIVATE SOURCE','revision','commit','tree','source','private/bundle','hash',100,'READY',?,?,'WORKER','READY','hash',25)").run(stamp,new Date(Date.now()+60000).toISOString());
 data=await(await f.call()).json();
 for(const id of ['queues','workflows','containers','workers-ai','ai-gateway','platforms','dns','secrets','browser']){const row=data.services.find(row=>row.id===id);assert.equal(row.state,'observed',id);assert.equal(row.checkedAt,stamp);assert.match(row.detail,/not a current provider health probe/);}
 assert.equal(data.services.find(row=>row.id==='access').state,'available');assert.equal(data.metrics.find(row=>row.id==='previews.bytes').value,125);assert.ok(!JSON.stringify(data).includes('PRIVATE SOURCE'));assert.ok(!JSON.stringify(data).includes('private/report'));
 f.sql.exec("UPDATE previews SET purged=1");data=await(await f.call()).json();assert.equal(data.services.find(row=>row.id==='platforms').state,'configured');assert.equal(data.metrics.find(row=>row.id==='previews.bytes').value,0);
});

test('maintenance isolates failed stages, journals sanitized outcomes, and preserves last success',async t=>{
 const f=await fixture(t);let ran=0;
 await assert.rejects(runMaintenance(f.env,[['ci',async()=>{throw Error('SECRET provider error')}],['previews',async()=>{ran++;return {purged:2,pending:1}}],['evidence',async()=>({resent:1,stopped:1,pending:0})],['indexes',async()=>({deleted:3})]]),/Inspect the operations dashboard/);
 assert.equal(ran,1);assert.equal(f.sql.prepare("SELECT processed FROM operations_maintenance WHERE stage='ci'").get().processed,null);assert.equal(f.sql.prepare("SELECT outcome FROM operations_maintenance WHERE stage='ci'").get().outcome,'failed');
 assert.equal(f.sql.prepare("SELECT outcome FROM operations_maintenance WHERE stage='previews'").get().outcome,'degraded');
 const successful=f.sql.prepare("SELECT * FROM operations_maintenance WHERE stage='evidence'").get();assert.equal(successful.processed,2);assert.ok(successful.last_success_at);
 await assert.rejects(runMaintenance(f.env,[['evidence',async()=>{throw Error('SECRET')}]]));
 assert.equal(f.sql.prepare("SELECT last_success_at FROM operations_maintenance WHERE stage='evidence'").get().last_success_at,successful.last_success_at);
 const data=await (await f.call()).json();assert.equal(data.services.find(s=>s.id==='maintenance.ci').state,'degraded');assert.ok(!JSON.stringify(data).includes('SECRET'));
});

test('additive operations migration does not infer admin roles and safely resumes partial installation',async t=>{
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,can_create INTEGER); CREATE TABLE evidence_jobs(state TEXT,created_at TEXT); CREATE TABLE app_resources(state TEXT,kind TEXT); INSERT INTO users VALUES(1,1)');
 const migration=await readFile(new URL('./migrations/0010_operations.sql',import.meta.url),'utf8');sql.exec(migration.split(';')[0]+';');sql.exec(migration);sql.exec(migration);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM operations_admins').get().n,0);
});


test('provider metrics use fixed account/Worker query, retain last success on failure and do not collect on dashboard refresh',async t=>{
 const f=await fixture(t);Object.assign(f.env,{ACCOUNT_ID:'a'.repeat(32),OPERATIONS_WORKER:'golf-test',OPERATIONS_ANALYTICS_TOKEN:{async get(){return 'test-secret-value-1234567890'}}});
 let calls=0;
 const provider=async(url,options)=>{calls++;assert.equal(url,'https://api.cloudflare.com/client/v4/graphql');assert.equal(options.redirect,'error');const request=JSON.parse(options.body);assert.equal(request.variables.scriptName,'golf-test');assert.equal(request.variables.accountTag,'a'.repeat(32));assert.equal(Date.parse(request.variables.end)-Date.parse(request.variables.start),1800000);
  return Response.json({data:{viewer:{accounts:[{workersInvocationsAdaptive:[{dimensions:{scriptName:'golf-test'},sum:{requests:3,errors:0,subrequests:2}}]}]}},errors:null});};
 await collectWorkerMetrics(f.env,provider);await collectWorkerMetrics(f.env,provider);assert.equal(calls,1);
 let data=await(await f.call()).json();assert.equal(data.metrics.find(m=>m.id==='provider.requests').value,3);assert.equal(data.metrics.find(m=>m.id==='provider.errors').value,0);assert.equal(calls,1);
 const success=f.sql.prepare('SELECT observed_at FROM operations_provider').get().observed_at;
 f.sql.exec("UPDATE operations_provider SET attempted_at='2000-01-01T00:00:00Z'");
 await assert.rejects(collectWorkerMetrics(f.env,async()=>Response.json({data:{viewer:{accounts:[{workersInvocationsAdaptive:[]}]}},errors:null})),/collection failed/);
 data=await(await f.call()).json();assert.equal(data.services.find(s=>s.id==='provider.analytics').state,'degraded');assert.equal(data.metrics.find(m=>m.id==='provider.requests').value,3);assert.equal(data.metrics.find(m=>m.id==='provider.requests').observedAt,success);assert.ok(!JSON.stringify(data).includes('test-secret'));
});

test('operations configuration rejects excessive sampling, secrets values, unknown fields and malformed references',()=>{
 assert.deepEqual(operationsPolicy({}),{observability:{enabled:false}});
 const policy=operationsPolicy({operations:{analytics_secret:{store:'a'.repeat(32),name:'golf-analytics'},observability:{enabled:true,sampling:.1}}});assert.equal(policy.observability.logs.invocationLogs,false);assert.equal(policy.observability.redactQueryString,true);assert.equal(policy.observability.traces.enabled,false);
 for(const operations of [{observability:{enabled:true,sampling:1}},{analytics_secret:{store:'a'.repeat(32),name:'x',token:'private'}},{analytics_secret:{store:'bad',name:'x'}},{url:'https://attacker.invalid'},[]])assert.throws(()=>operationsPolicy({operations}));
});


test('read-only service probes verify Artifacts allocation, preserve last success and never allocate resources',async t=>{
 const f=await fixture(t);let reads=0,disposed=0;
 Object.assign(f.env,{OPERATIONS_SERVICE_HEALTH:'true',ACCOUNT_ID:'a'.repeat(32),ARTIFACTS_NAMESPACE:'test-space',EVIDENCE_BUCKET:{async head(key){assert.equal(key,'operations/read-health-probe');reads++;return null}},ARTIFACTS:{async get(name){return {async info(){return {name,remote:`https://${'a'.repeat(32)}.artifacts.cloudflare.net/git/test-space/${name}.git`}},[Symbol.dispose](){disposed++}}}}});
 f.sql.prepare("INSERT INTO repositories(name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES('project','','owned',1,'key','hash','ACTIVE',?)").run(new Date().toISOString());
 await collectServiceHealth(f.env);await collectServiceHealth(f.env);assert.equal(reads,1);assert.equal(disposed,1);
 let data=await(await f.call()).json();assert.equal(data.services.find(s=>s.id==='artifacts').state,'available');assert.equal(data.services.find(s=>s.id==='r2').state,'available');
 f.sql.exec("UPDATE operations_provider SET attempted_at='2000-01-01T00:00:00Z'");f.env.EVIDENCE_BUCKET.head=async()=>{throw Error('private provider credential')};
 await assert.rejects(collectServiceHealth(f.env));data=await(await f.call()).json();assert.equal(data.services.find(s=>s.id==='r2').state,'degraded');assert.ok(!JSON.stringify(data).includes('private provider'));
});


test('dead-letter intake retains original jobs idempotently, excludes arbitrary bodies and creates no execution',async t=>{
 const f=await fixture(t);Object.assign(f.env,{EVIDENCE_DEAD_LETTER_QUEUE:'golf-dead',EVIDENCE_QUEUE:{send(){assert.fail('Dead-letter intake must not dispatch a replacement')}},EVIDENCE_BUCKET:{},EVIDENCE_WORKFLOW_NAME:'golf-evidence',EVIDENCE_DAILY_LIMIT:'2',EVIDENCE_QUEUE_NAME:'golf-evidence'});
 const stamp=new Date().toISOString(),jobId='12345678-1234-4234-8234-123456789012';
 f.sql.prepare("INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'project','','owned',1,'key','hash','ACTIVE',?)").run(stamp);
 f.sql.prepare("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at) VALUES(?,1,1,'key','hash','{}','NONE',?,?,?)").run(jobId,stamp,stamp,stamp);
 let ack=0;const message={id:'provider-message',body:{jobId},ack(){ack++},retry(){assert.fail('Durable persistence succeeded')}};
 await consumeEvidenceDeadLetters({queue:'golf-dead',messages:[message,message,{...message,id:'bad',body:{jobId,secret:'must not retain'}}]},f.env);
 assert.equal(ack,3);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM operations_delivery_failures').get().n,1);
 assert.equal(f.sql.prepare('SELECT state FROM evidence_jobs').get().state,'QUEUED');assert.equal((await(await f.call()).json()).metrics.find(row=>row.id==='delivery.failed').value,1);
 await assert.rejects(consumeEvidenceDeadLetters({queue:'foreign',messages:[]},f.env));
});
