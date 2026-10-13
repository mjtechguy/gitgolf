import importlib.util
import http.client
from pathlib import Path
import unittest
from unittest.mock import Mock
import urllib.error

spec = importlib.util.spec_from_file_location('demo_launcher', Path(__file__).with_name('cloudflare-forge-smoke.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class DemoTransportTests(unittest.TestCase):
    def test_tls_and_body_timeouts_retry_safe_reads_and_original_idempotent_requests(self):
        for path, payload in [('/rpc/golf.v1.RepositoryService/GetContents', {}), ('/native/pr-evidence', {'idempotencyKey': 'original-key'}), ('/native/pr-evidence', {'action': 'status', 'jobId': 'original-job'}), ('/native/pr-preview', {'action': 'list'})]:
            call = Mock(side_effect=[urllib.error.URLError(TimeoutError('TLS timeout')), http.client.RemoteDisconnected('connection closed'), TimeoutError('body timeout'), 'original-result'])
            self.assertEqual(launcher.retry_native_http(call, path, payload, 'POST'), 'original-result')
            self.assertEqual(call.call_count, 4)

    def test_unknown_writes_and_other_network_failures_are_never_replayed(self):
        call = Mock(side_effect=TimeoutError('uncertain write'))
        with self.assertRaises(TimeoutError):
            launcher.retry_native_http(call, '/native/repository-grant', {'role': 'write'}, 'POST')
        self.assertEqual(call.call_count, 1)
        call = Mock(side_effect=urllib.error.URLError('permission denied'))
        with self.assertRaises(urllib.error.URLError):
            launcher.retry_native_http(call, '/rpc/GetContents', {}, 'POST')
        self.assertEqual(call.call_count, 1)


if __name__ == '__main__':
    unittest.main()
