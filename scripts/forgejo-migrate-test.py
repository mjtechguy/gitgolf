#!/usr/bin/env python3
"""Boundaries and response-loss behavior of the selected-repository staging tool."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('migration',Path(__file__).with_name('forgejo-migrate.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class MigrationTests(unittest.TestCase):
    def test_verify_does_not_signal_cutover_success(self):
        with tempfile.TemporaryDirectory() as d:
            args=['forgejo-migrate.py','verify','--journal',str(Path(d)/'journal.json')]
            value={'operation':'fixture','phase':'verified-staging','cutoverAllowed':False,'blockers':m.BLOCKERS,
                'reconciliation':{'pull_reviews':{'matches':False}}}
            output=io.StringIO()
            with patch.object(sys,'argv',args),patch.object(m,'execute',return_value=value),contextlib.redirect_stdout(output):
                self.assertEqual(m.main(),3)
            self.assertFalse(json.loads(output.getvalue())['cutoverAllowed'])
            self.assertEqual(json.loads(output.getvalue())['mismatches'],['pull_reviews'])

    def test_origins(self):
        for url in ('http://remote.invalid','https://u:p@example.invalid','https://example.invalid/path','https://example.invalid?token=x','file:///tmp/source'):
            with self.assertRaises(ValueError):m.origin(url)
        self.assertEqual(m.origin('https://git.example.invalid/'),'https://git.example.invalid')
        self.assertEqual(m.origin('http://127.0.0.1:34343'),'http://127.0.0.1:34343')

    def test_repeated_pages_and_limits_are_not_absence(self):
        api=m.API('https://example.invalid','private-token')
        with patch.object(api,'request',return_value=[{'id':1}]):
            with self.assertRaisesRegex(ValueError,'Repeated'):api.pages('/repos')
        with patch.object(api,'request',side_effect=[[{'id':1}],[]]):
            self.assertEqual(api.pages('/repos'),[{'id':1}])

    def test_comparison_preserves_source_commits_and_discussion_fields(self):
        a={'branches':[{'name':'main','commit':{'id':'a'*40}}], 'issues':[{'number':1,'title':'one','body':'private','created_at':'2026-01-01'}]}
        b=json.loads(json.dumps(a));b['branches'][0]['commit']['id']='b'*40
        self.assertNotEqual(m.summary(a),m.summary(b))
        b=json.loads(json.dumps(a));b['issues'][0]['created_at']='2026-01-02'
        self.assertNotEqual(m.summary(a),m.summary(b))

    def test_atomic_private_journal(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'journal.json'
            m.save(path,{'phase':'dispatching'});m.private_file(path)
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            m.save(path,{'phase':'imported'})
            self.assertEqual(json.loads(path.read_bytes())['phase'],'imported')
            path.chmod(0o644)
            with self.assertRaises(ValueError):m.private_file(path)

    def test_lost_response_never_replays_creation_or_adopts_another_repo(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'journal.json'
            state={'repository':{'id':1},'branches':[]}
            value={'format':'golf.forgejo.transfer.v1','operation':'op','phase':'dispatching','source':'https://source.invalid',
                'target':'https://target.invalid','repository':'alice/repo','destination':'bob/repo','ownerID':7,'sourceID':1,
                'sourceSummary':m.summary(state),'sourceRepository':{k:None for k in m.REPOSITORY_FIELDS},'blockers':m.BLOCKERS,'cutoverAllowed':False,'encryptedInventorySHA256':'a'*64}
            m.save(path,value)
            args=argparse.Namespace(phase='import',journal=path,source_frozen=True,target_quarantined=True)
            calls=[]
            def request(api,method,route,payload=None,allow_missing=False):
                calls.append(method)
                if route=='/version':return {'version':'1.27.3' if 'source' in api.url else '15.0.9+gitea-1.22.0'}
                return {'id':9,'full_name':'bob/repo','owner':{'id':7},'private':True,'description':'unrelated'}
            with patch.dict(os.environ,{'GOLF_MIGRATION_SOURCE_TOKEN':'source-token','GOLF_MIGRATION_TARGET_TOKEN':'target-token'}),patch.object(m.API,'request',request),patch.object(m,'snapshot',return_value=state):
                with self.assertRaisesRegex(ValueError,'marker mismatch'):m.execute(args)
            self.assertNotIn('POST',calls)
            self.assertEqual(json.loads(path.read_bytes())['phase'],'dispatching')

if __name__=='__main__':unittest.main()
