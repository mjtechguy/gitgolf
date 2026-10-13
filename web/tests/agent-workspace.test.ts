import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobMatchesPull, pullStage } from '../src/agentWorkspace.ts';
import { repositoryOptions, defaultRepositorySearch } from '../src/navigation.ts';
import type { Job, Pull } from '../src/NativeForge';

const pull: Pull={id:'9',number:3,title:'A task',body:'',state:'ISSUE_STATE_OPEN',merged:false,draft:false,revision:'revision',base:{ref:'main',commitId:'a'.repeat(40)},head:{ref:'work',commitId:'b'.repeat(40)}};
const job: Job={id:'job',idempotencyKey:'key',state:'SUCCEEDED',agentState:'succeeded',testState:'PASSED',adviceState:'NONE',stale:false,createdAt:'',updatedAt:'',selection:{repositoryId:'2',pullRequestId:'9',number:3,baseCommitId:pull.base.commitId,headCommitId:pull.head.commitId}};
test('workspace evidence must match repository, PR, both commits and current authority observation',()=>{
 assert.equal(jobMatchesPull(job,pull,'2'),true);
 assert.equal(jobMatchesPull({...job,stale:true},pull,'2'),false);
 assert.equal(jobMatchesPull(job,pull,'3'),false);
 for(const change of [{pullRequestId:'10'},{number:4},{headCommitId:'c'.repeat(40)},{baseCommitId:'c'.repeat(40)}])assert.equal(jobMatchesPull({...job,selection:{...job.selection,...change}},pull,'2'),false);
 assert.equal(pullStage(pull),'Open for review');
 assert.equal(pullStage({...pull,draft:true}),'Draft');
 assert.equal(pullStage({...pull,state:'ISSUE_STATE_CLOSED'}),'Closed');
 assert.equal(pullStage({...pull,merged:true,state:'ISSUE_STATE_CLOSED'}),'Merged');
});
test('agent workspace keeps selected PR in canonical links and removes execution selections',()=>{
 const link=repositoryOptions({...defaultRepositorySearch,owner:'mj',name:'repo',view:'actions',run:'old-run'},{view:'agents',pull:3});
 assert.equal(link.params._splat,'agents/3');
 assert.equal(link.search.pull,undefined);assert.equal(link.search.run,undefined);
 const code=repositoryOptions({...defaultRepositorySearch,owner:'mj',name:'repo',view:'agents',pull:3},{view:'source'});
 assert.equal(code.search.pull,undefined);
});
