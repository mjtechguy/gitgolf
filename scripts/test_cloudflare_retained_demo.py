import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from cloudflare_retained_demo import seed

ROOT = Path(__file__).resolve().parents[1]


class PlaygroundResume(unittest.TestCase):
    def test_failure_retains_source_and_operation_identities_without_duplicate_ci(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            calls = []
            fail = True
            def git(label, *args):
                if args[0] == 'init': Path(args[-1]).mkdir()
                if args[0] == 'clone': Path(args[-1]).mkdir()
                return SimpleNamespace(stdout=b'head\n')
            def rpc(method, body):
                calls.append((method, body['idempotencyKey']))
                if method == 'CreateRepository': return {'repository': {'id': body['name'], 'cloneUrl': 'https://example.test/repo.git'}}
                return {'pullRequest': {'id': 'pull', 'number': 1}}
            def http(path, body):
                if path == '/native/pr-evidence':
                    if body['action'] == 'create':
                        calls.append(('create-job', body['idempotencyKey']))
                        return {'job': {'id': body['selection']['repositoryId']}}
                    if body['action'] == 'status':
                        if fail: raise OSError('lost response')
                        return {'job': {'state': 'SUCCEEDED'}}
                    return {'report': {'tests': {'state': 'PASSED', 'exitCode': 0, 'cleanup': 'destroyed', 'commitId': 'head', 'image': {'digest': 'digest'}}}}
                if path == '/native/repository-packages': return {'provider': 'cloudflare', 'artifacts': [{'digest': 'digest'}]}
                return {'previews': [{'state': 'READY', 'purged': False, 'kind': kind} for kind in ['STATIC', 'WORKER']]}
            with self.assertRaisesRegex(OSError, 'lost response'):
                seed(directory, ROOT, 'alice', rpc, http, git, lambda *_: None)
            original = json.loads((directory/'playground-seed.json').read_text())['repositories']['canonical']
            fail = False
            result = seed(directory, ROOT, 'alice', rpc, http, git, lambda *_: None)
            self.assertEqual(len(result['runs']), 2)
            self.assertEqual(len(calls), 6)
            self.assertEqual(json.loads((directory/'playground-seed.json').read_text())['repositories']['canonical'], original)
