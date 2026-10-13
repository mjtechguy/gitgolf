import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cloudflare_alchemy_demo as demo
from cloudflare_setup import replace_private_json


class InstallationBoundary(unittest.TestCase):
    def test_private_installation_must_match_its_directory_and_account(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root/'.tmp/cloudflare-forge/example'
            directory.mkdir(parents=True, mode=0o700)
            config = {'name': 'example', 'account': 'a'*32}
            replace_private_json(directory/'alchemy-input.json', config)
            with patch.object(demo, 'ROOT', root):
                self.assertEqual(demo.load(directory)[1], config)
                directory.chmod(0o755)
                with self.assertRaises(ValueError): demo.load(directory)
                directory.chmod(0o700)
                replace_private_json(directory/'alchemy-input.json', {**config, 'name': 'another-installation'})
                with self.assertRaises(ValueError): demo.load(directory)

    def test_deploy_cannot_adopt_an_occupied_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            replace_private_json(directory/'operator.json', {'value': 'test-only-credential'})
            with patch.object(demo.subprocess, 'run') as run:
                run.return_value.returncode = 0
                demo.run(directory, {'account': 'a'*32, 'name': 'example'}, 'deploy')
                args = run.call_args.args[0]
                self.assertNotIn('--adopt', args)
                self.assertNotIn('test-only-credential', ' '.join(args))
                demo.run(directory, {'account': 'a'*32, 'name': 'example'}, 'plan')
                self.assertIn('--dry-run', run.call_args.args[0])

class SchemaBootstrap(unittest.TestCase):
    def test_redeploy_preserves_data_and_refuses_unreviewed_schema_change(self):
        import os
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            value = {'account': 'a'*32, 'name': 'example', 'email': 'demo@example.com', 'nativeToken': 'test-only'}
            settings = {'account': value['account'], 'worker': value['name'], 'database': {'uuid': 'database'}}
            with patch.dict(os.environ, GOLF_ALCHEMY_SETTINGS=json.dumps(settings)), patch.object(demo, 'cf') as cf, patch.object(demo.subprocess, 'run'):
                cf.return_value = [{'results': []}]
                demo.build(directory, value)
                self.assertEqual(sum('CREATE TABLE' in str(call) for call in cf.call_args_list), 1)
                cf.reset_mock()
                demo.build(directory, value)
                self.assertFalse(any('CREATE TABLE' in str(call) for call in cf.call_args_list))
                receipt = json.loads((directory/'schema-receipt.json').read_text())
                receipt['sha256'] = 'changed'
                replace_private_json(directory/'schema-receipt.json', receipt)
                with self.assertRaisesRegex(ValueError, 'Schema changed'): demo.build(directory, value)


class RunnerIdentity(unittest.TestCase):
    def test_verification_rejects_provenance_indexes_and_wrong_image_identity(self):
        import hashlib
        import io
        account = 'a'*32
        value = {'account': account, 'name': 'example', 'settings': {'tests': {'image_id': 'sha256:approved'}}}
        credential = {'account_id': account, 'registry_host': 'registry.cloudflare.com', 'username': 'test', 'password': 'test'}
        def check(manifest):
            data = json.dumps(manifest).encode()
            reference = 'registry.cloudflare.com/'+account+'/example@sha256:'+hashlib.sha256(data).hexdigest()
            with patch.object(demo, 'cf', return_value=credential), patch.object(demo.urllib.request, 'urlopen', return_value=io.BytesIO(data)):
                return demo.verify_image(value, reference)
        self.assertEqual(check({'config': {'digest': 'sha256:approved'}})['config'], 'sha256:approved')
        with self.assertRaisesRegex(ValueError, 'single-platform'): check({'manifests': []})
        with self.assertRaisesRegex(ValueError, 'approved local image'): check({'config': {'digest': 'sha256:different'}})


if __name__ == '__main__':
    unittest.main()
