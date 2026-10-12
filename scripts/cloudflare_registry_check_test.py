import gzip
import hashlib
import io
import json
import os
import tarfile
import unittest
from unittest.mock import patch
from fixtures import registry_publish
from cloudflare_registry_check import RegistryProof
from types import SimpleNamespace
from pathlib import Path
import tempfile
from cloudflare_setup import stop_owned_image_uploads
from unittest.mock import Mock

class PublicationTests(unittest.TestCase):
    def test_brokered_publication_has_valid_content_and_rejects_other_tags(self):
        calls = []
        class Response:
            def __init__(self, status, headers): self.status, self.headers = status, headers
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return b''
        def request(req, timeout):
            calls.append(req)
            digest = 'sha256:' + hashlib.sha256(req.data).hexdigest()
            if req.method == 'POST': self.assertTrue(req.full_url.endswith(digest))
            return Response(403 if req.full_url.endswith('/unauthorized') else 201, {'Docker-Content-Digest': digest})
        with patch.dict(os.environ, {'GOLF_REGISTRY': 'https://registry.test', 'GOLF_IMAGE': 'alice/repo:ci-owned', 'GOLF_COMMIT': 'a'*40}, clear=True), patch('urllib.request.urlopen', request):
            registry_publish.publish()
        self.assertEqual(len(calls), 4)
        manifest = json.loads(calls[2].data)
        config = json.loads(calls[0].data)
        layer = gzip.decompress(calls[1].data)
        self.assertEqual(config['rootfs']['diff_ids'], ['sha256:' + hashlib.sha256(layer).hexdigest()])
        self.assertEqual(manifest['layers'][0]['size'], len(calls[1].data))
        with tarfile.open(fileobj=io.BytesIO(layer)) as archive:
            self.assertIn(b'a'*40, archive.extractfile('payload').read())
        self.assertTrue(all('Authorization' not in req.headers for req in calls))

    def test_no_registry_authority_means_no_publication(self):
        with patch.dict(os.environ, {}, clear=True), patch('urllib.request.urlopen') as request:
            registry_publish.publish()
            request.assert_not_called()

class RegistryRequestTests(unittest.TestCase):
    def test_registry_enable_waits_on_read_only_binding_receipt(self):
        proof = RegistryProof.__new__(RegistryProof)
        repository = {'name': 'repo', 'id': '1'}
        http = Mock(side_effect=[{'code': 'unimplemented'}, {'repositoryId': '1', 'enabled': False}, {'enabled': True}])
        with patch('cloudflare_registry_check.time.sleep'):
            proof.enable(http, repository)
        self.assertEqual([call.args[1]['action'] for call in http.call_args_list], ['status', 'status', 'enable'])
        for response in [{'repositoryId': '2'}, {'code': 'permission_denied'}]:
            http = Mock(return_value=response)
            with self.assertRaises(RuntimeError): proof.enable(http, repository)
            self.assertEqual(http.call_count, 1)
        http = Mock(return_value={'code': 'unimplemented'})
        with patch('cloudflare_registry_check.time.sleep'), self.assertRaises(RuntimeError): proof.enable(http, repository)
        self.assertEqual(http.call_count, 180)

    def test_registry_client_identifies_itself_without_changing_authority(self):
        proof = RegistryProof.__new__(RegistryProof)
        proof.origin = 'https://registry.test'
        response = Mock(status=200, headers={})
        response.read.return_value = b'{}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=None)
        proof.client = Mock()
        proof.client.open.return_value = response
        proof.request('/v2/', token='scoped-token')
        request = proof.client.open.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'), 'GolfRegistryQualification/1')
        self.assertEqual(request.get_header('Authorization'), 'Bearer scoped-token')

class CleanupIdentityTests(unittest.TestCase):
    def proof(self, code, body=b'', error=b''):
        proof = RegistryProof.__new__(RegistryProof)
        proof.name = 'golf-owned-registry'
        proof.args = SimpleNamespace(profile='golf')
        proof.state = {'registry_attempted': True, 'resources': {'registry_worker': {'id': 'owned', 'name': proof.name}}}
        proof.command = Mock(return_value=SimpleNamespace(returncode=code, stdout=body, stderr=error))
        return proof

    def test_absent_partial_deployment_is_not_recreated(self):
        proof = self.proof(1, error=b'404 Not Found')
        proof.retire()
        self.assertEqual(proof.command.call_count, 1)

    def test_changed_identity_or_unavailable_provider_cannot_be_deleted(self):
        for proof in [self.proof(0, b'{"id":"foreign","name":"golf-owned-registry"}'), self.proof(1, error=b'503 Unavailable')]:
            with self.assertRaises(RuntimeError): proof.current_worker()

    def test_only_exact_owned_detached_upload_is_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            for pid, image in [('101', 'owned:test'), ('102', 'foreign:test')]:
                path = Path(directory)/pid; path.mkdir()
                (path/'cmdline').write_bytes(b'docker\0push\0registry.cloudflare.com/' + b'a'*32 + b'/' + image.encode() + b'\0')
            with patch('os.pidfd_open', side_effect=lambda pid: pid), patch('os.close'), patch('signal.pidfd_send_signal') as kill:
                self.assertEqual(stop_owned_image_uploads('a'*32, ['owned:test'], Path(directory)), [101])
                self.assertEqual(kill.call_count, 1)
                self.assertEqual(kill.call_args.args[0], 101)

    def test_empty_bucket_cleanup_accepts_cli_array_inventory(self):
        proof = self.proof(1, error=b'404 Not Found')
        proof.state = {'resources': {'registry_bucket': {'name': proof.name, 'creation_date': 'owned'}}}
        proof.command = Mock(side_effect=[SimpleNamespace(returncode=0, stdout=json.dumps(proof.state['resources']['registry_bucket']).encode()), SimpleNamespace(returncode=1, stderr=b'404 Not Found')])
        proof.cf = Mock(side_effect=[[], None])
        proof.remove()
        self.assertEqual(proof.cf.call_args.args[1:3], ('r2', 'buckets'))

    def test_original_worker_is_recognized(self):
        proof = self.proof(0, b'{"id":"owned","name":"golf-owned-registry"}')
        self.assertEqual(proof.current_worker()['id'], 'owned')

if __name__ == '__main__': unittest.main()
