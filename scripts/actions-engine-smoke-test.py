#!/usr/bin/env python3
"""Pure launcher assertion tests; no Docker, HTTP, native actors or provider calls."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).parent))
spec=importlib.util.spec_from_file_location('actions_smoke',Path(__file__).with_name('actions-engine-smoke.py'))
proof=importlib.util.module_from_spec(spec);spec.loader.exec_module(proof)

class ReceiptAssertions(unittest.TestCase):
    def setUp(self):
        self.native={'id':7,'owner':{'id':8}}
        self.head='a'*40;self.blob='b'*40
        self.run={'id':'d5655647-0b60-416d-9e43-05cd6ec44e17','repositoryId':'7','ownerId':'8','commitId':self.head,
                  'workflowPath':'.github/workflows/mixed.yml','workflowBlobId':self.blob,'engineCatalog':proof.CATALOG,'engineCommit':proof.ENGINE,
                  'attemptId':'c'*32,'sourceSha256':'d'*64,'origin':'WORKFLOW_RUN_ORIGIN_MANUAL','runnerId':'local-docker',
                  'state':'WORKFLOW_RUN_STATE_FAILED','startedAt':'2026-10-04T00:00:00Z','finishedAt':'2026-10-04T00:00:06Z','jobs':[]}
        fixtures=[
            ('cd46c3f2a99d7b47b380de99589dd871','cells','a',[], 'FAILED',[('cell','FAILED'),('ownfailure','SUCCEEDED'),('ownsuccess','SKIPPED')],0,2),
            ('82ab1fc3136385e7248c0ca38f50f015','cells','b',[], 'SUCCEEDED',[('cell','SUCCEEDED'),('ownfailure','SKIPPED'),('ownsuccess','SUCCEEDED')],2,4),
            ('4981abfc21b8cfee1fd29e50c8e3113d','aftermath',None,['cells'],'SUCCEEDED',[('dependency','SUCCEEDED')],4,5),
            ('89f659c16d24629fd44c1b0913c5bade','skipped',None,['cells'],'SKIPPED',[('0','SKIPPED')],None,5),
        ]
        for identifier,job,cell,needs,state,steps,start,end in fixtures:
            stamp=lambda n:'2026-10-04T00:00:0'+str(n)+'Z'
            item={'instanceId':identifier,'jobId':job,'needs':needs,'state':proof.STATE+state,'eventsRecorded':True,'imageDigest':proof.IMAGE,
                  'finishedAt':stamp(end),'steps':[{'id':key,'state':proof.STATE+outcome} for key,outcome in steps]}
            if cell:item['matrix']=[{'name':'cell','valueJson':'"'+cell+'"'}]
            if start is not None:item['startedAt']=stamp(start)
            for step in item['steps']:
                if step['state']!=proof.STATE+'SKIPPED':step.update(startedAt=stamp(start),finishedAt=stamp(end))
                elif start is not None:step['finishedAt']=stamp(end)
            self.run['jobs'].append(item)

    def verify(self,run):
        return proof.check_run(run,self.native,self.head,'.github/workflows/mixed.yml',self.blob,True)

    def test_actual_independent_expected_failure_success_and_skip_contract(self):
        self.assertEqual(len(self.verify(self.run)),4)

    def test_inherited_failed_header_cannot_pass_as_successful_sibling_result(self):
        bad=copy.deepcopy(self.run);bad['jobs'][1]['state']=proof.STATE+'FAILED'
        with self.assertRaises(AssertionError):self.verify(bad)

    def test_empty_duplicate_inventory_wrong_scope_and_unrecorded_children_deny(self):
        variants=[]
        for field,value in [('repositoryId','9'),('commitId','f'*40),('sourceSha256',''),('engineCommit','f'*40),('exitCode',0)]:
            bad=copy.deepcopy(self.run);bad[field]=value;variants.append(bad)
        bad=copy.deepcopy(self.run);bad['jobs'][2]=bad['jobs'][1];variants.append(bad)
        bad=copy.deepcopy(self.run);bad['jobs'][0]['steps'][1]['state']=proof.STATE+'UNRECORDED';variants.append(bad)
        bad=copy.deepcopy(self.run);bad['jobs'][3]['startedAt']=bad['startedAt'];variants.append(bad)
        bad=copy.deepcopy(self.run);bad['jobs'][2]['startedAt']=bad['startedAt'];variants.append(bad)
        for bad in variants:
            with self.subTest(),self.assertRaises(AssertionError):self.verify(bad)

    def test_filtered_global_sequence_gaps_advance_but_exact_scope_receipt_is_required(self):
        pages=[{'logs':[{'sequence':'4','text':'own-'}],'hasMore':True}, {'logs':[{'sequence':'9','text':'scope'}]}]
        calls=[]
        def rpc(method,request):
            calls.append(request)
            return {**pages[len(calls)-1],'runId':self.run['id'],'attemptId':self.run['attemptId'],'repositoryId':'7','sourceCommitId':self.head,
                    'jobInstanceId':'e'*32,'stepId':'cell'}
        self.assertEqual(proof.read_logs(rpc,self.run,'e'*32,'cell'),'own-scope')
        self.assertEqual([row['afterSequence'] for row in calls],['0','4'])
        def wrong(method,request):return {'runId':self.run['id'],'attemptId':'f'*32,'repositoryId':'7','sourceCommitId':self.head}
        with self.assertRaises(AssertionError):proof.read_logs(wrong,self.run)

    def test_unsliced_sequence_gap_or_empty_continuation_cannot_hide_missing_output(self):
        def rpc(method,request):return {'runId':self.run['id'],'attemptId':self.run['attemptId'],'repositoryId':'7','sourceCommitId':self.head,
                                       'logs':[{'sequence':'2','text':'missing first'}]}
        with self.assertRaises(AssertionError):proof.read_logs(rpc,self.run)
        def empty(method,request):return {'runId':self.run['id'],'attemptId':self.run['attemptId'],'repositoryId':'7','sourceCommitId':self.head,'hasMore':True}
        with self.assertRaises(AssertionError):proof.read_logs(empty,self.run)

if __name__=='__main__':unittest.main()
