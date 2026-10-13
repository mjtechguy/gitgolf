import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import cloudflare_setup as setup


class CloudflareSetupTest(unittest.TestCase):
    def test_independent_private_setup_and_real_compose_all_supported_components(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'installation'
            setup.initialize(directory, 'a' * 32, 'control.example.com', 'origin.example.com', 'private-test',
                             ['agents', 'email', 'webhooks', 'remote-actions', 'managed-git'])
            original = setup.private_read(directory / 'bridge.env')
            self.assertIn('FORGEJO_DB_PASSWORD=', original)
            self.assertIn('GOLF_FORGE_INSTANCE_ID=', original)
            self.assertNotIn('GITEA_DB_PASSWORD=', original)
            with self.assertRaises(FileExistsError):
                setup.initialize(directory, 'a' * 32, 'control.example.com', 'origin.example.com', 'private-test', [])
            self.assertEqual(original, setup.private_read(directory / 'bridge.env'))
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual((directory / 'bridge.env').stat().st_mode & 0o777, 0o600)
            # Certificates really verify for the native origin and TLS runner names.
            for host in ['golf', 'localhost']:
                result = subprocess.run(['openssl', 'verify', '-CAfile', str(directory / 'origin.crt'),
                    '-verify_hostname', host, str(directory / 'origin.crt')], capture_output=True)
                self.assertEqual(result.returncode, 0)
            contents = original.replace("GOLF_OBJECT_ACCESS_KEY_ID=''", "GOLF_OBJECT_ACCESS_KEY_ID='test-key'").replace(
                "GOLF_OBJECT_SECRET_ACCESS_KEY=''", "GOLF_OBJECT_SECRET_ACCESS_KEY='test-secret'").replace(
                "GOLF_AGENT_IMAGE=''", "GOLF_AGENT_IMAGE='sha256:" + 'b' * 64 + "'")
            contents += "GOLF_REMOTE_ACTIONS_BUNDLES='/private/bundles.json'\nGOLF_RUNNER_ACTIONS_EGRESS_HOST='192.0.2.1'\n"
            contents += "GOLF_MANAGED_HTTP_GIT_PUBLIC_URL='https://control.example.com'\n"
            (directory / 'bridge.env').write_text(contents)
            with patch.dict(os.environ, {'GOLF_PUBLIC_URL': 'http://unrelated.local', 'COMPOSE_PROJECT_NAME': 'golf',
                                          'GOLF_OBJECT_ENDPOINT': 'http://unrelated.local', 'GOLF_ALLOW_INSECURE_COOKIES': 'true'}):
                command = setup.compose_command(directory, ['config', '--format', 'json'])
                result = subprocess.run(command, env=setup.clean_environment(), capture_output=True)
            self.assertEqual(result.returncode, 0, 'Compose rejected the isolated configuration; private output withheld')
            config = json.loads(result.stdout)
            self.assertEqual(config['name'], 'golf-cloudflare')
            services = config['services']
            self.assertIn('forgejo', services)
            self.assertNotIn('gitea', services)
            self.assertNotIn('rustfs', services)
            for service in services.values():
                self.assertFalse(service.get('ports'))
            for name in ['golf', 'agent-worker', 'email-worker', 'webhook-worker']:
                self.assertEqual(services[name]['environment']['GOLF_PUBLIC_URL'], 'https://control.example.com')
                self.assertEqual(services[name]['environment']['GOLF_ALLOW_INSECURE_COOKIES'], 'false')
            self.assertEqual(services['golf']['environment']['GOLF_OBJECT_ENDPOINT'], 'https://' + 'a' * 32 + '.r2.cloudflarestorage.com')
            self.assertEqual(services['golf']['environment']['GOLF_DEPLOYMENT_RUNTIME'], 'cloudflare-bridge')
            self.assertEqual(services['agent-worker']['environment']['GOLF_OBJECT_ALLOW_HTTP'], 'false')
            self.assertEqual(services['runner']['environment']['GOLF_RUNNER_URL'], 'https://localhost:8443')
            self.assertIn('--token-file', services['cloudflared']['command'])
            self.assertNotIn('environment', services['cloudflared'])
            for volume in config['volumes'].values():
                self.assertTrue(volume['name'].startswith('golf-cloudflare_'))

    def test_rejects_unsafe_configuration_without_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'installation'
            for host in ['https://example.com', 'example.com/path', 'a..example.com', 'EXAMPLE.com', 'a\n.example.com']:
                with self.assertRaises(ValueError):
                    setup.initialize(directory, 'a' * 32, host, 'origin.example.com', 'private-test', [])
                self.assertFalse(directory.exists())
            file = Path(temporary) / 'secret'
            setup.private_write(file, 'secret')
            alias = Path(temporary) / 'alias'
            alias.symlink_to(file)
            with self.assertRaises(OSError):
                setup.private_read(alias)
            file.chmod(0o644)
            with self.assertRaises(ValueError):
                setup.private_read(file)


if __name__ == '__main__':
    unittest.main()
