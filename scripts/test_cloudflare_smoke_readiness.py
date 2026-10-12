import importlib.util
import contextlib
import io
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import urllib.error

spec = importlib.util.spec_from_file_location('cloudflare_smoke', Path(__file__).with_name('cloudflare-forge-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class ReadinessTest(unittest.TestCase):
    def test_unattended_requires_own_host_and_forbids_human_login_before_allocating(self):
        base = ['cloudflare-forge-smoke.py', '--account-id', 'a' * 32,
                '--profile', 'golf', '--workers-subdomain', 'qualification', '--unattended']
        for extra in [[], ['--demo-host', 'golf.example.com', '--demo-email', 'reader@example.com']]:
            with self.subTest(extra=extra), patch('sys.argv', base + extra), patch.object(Path, 'mkdir') as allocate, contextlib.redirect_stderr(io.StringIO()) as error:
                with self.assertRaises(SystemExit) as result:
                    smoke.main()
                self.assertEqual(result.exception.code, 2)
                self.assertIn('--unattended requires --demo-host and forbids --demo-email', error.getvalue())
                allocate.assert_not_called()

    def test_dns_timeout_and_routing_failures_retry_only_the_session_read(self):
        read = Mock(side_effect=[urllib.error.URLError('DNS pending'), TimeoutError(), RuntimeError('Routing pending'), {'user': {'id': '1'}}])
        with patch.object(smoke.time, 'sleep') as wait:
            self.assertEqual(smoke.await_session(read)['user']['id'], '1')
        self.assertEqual(read.call_count, 4)
        self.assertEqual(wait.call_count, 3)

    def test_failure_is_bounded_and_wrong_identity_is_not_retried(self):
        read = Mock(side_effect=urllib.error.URLError('DNS unavailable'))
        with patch.object(smoke.time, 'sleep') as wait:
            with self.assertRaises(urllib.error.URLError): smoke.await_session(read)
        self.assertEqual(read.call_count, 180)
        self.assertEqual(wait.call_count, 179)
        read = Mock(return_value={'user': {'id': 'foreign'}})
        with self.assertRaisesRegex(RuntimeError, 'actor'): smoke.await_session(read)
        self.assertEqual(read.call_count, 1)
