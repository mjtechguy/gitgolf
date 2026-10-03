#!/usr/bin/env python3
"""Bounded executable route/receive negative corpus; no native side effects."""
import unittest
from classifier import Denied, classify

INTENT = {'owner': 'fixture', 'repository': 'source', 'branch': 'feature',
          'old': '1' * 40, 'new': '2' * 40}
HEADERS = {'Authorization': 'Basic Zml4dHVyZTpzZWNyZXQ='}
GIT = '/fixture/source.git'


def receive(old=INTENT['old'], new=INTENT['new'], ref='refs/heads/feature', caps='report-status side-band-64k agent=git/2.50.0', extra=b''):
    line = f'{old} {new} {ref}\0{caps}\n'.encode()
    return f'{len(line) + 4:04x}'.encode() + line + extra + b'0000PACK' + b'\0' * 12


class ClassifierTests(unittest.TestCase):
    def test_reads(self):
        for target in ('/api/v1/version', '/api/v1/repos/fixture/source',
                       '/api/v1/repos/fixture/source/branches/main',
                       GIT + '/info/refs?service=git-upload-pack', GIT + '/info/refs?service=git-receive-pack'):
            self.assertTrue(classify('GET', target, HEADERS, b'', INTENT))
        self.assertEqual(classify('POST', GIT + '/git-upload-pack',
            HEADERS | {'Content-Type': 'application/x-git-upload-pack-request'}, b'0000', INTENT), 'git-upload-read')

    def test_unknown_aliases_and_methods(self):
        targets = ('/api/v1/repos/fixture/source/pulls/1', '/api/internal/serv/command',
            '/fixture/source/pulls/1/merge', '/fixture/source/settings/branches/edit',
            '/user/login', '/login/oauth/authorize', '/admin', '/unknown',
            '/api/v1/%72epos/fixture/source', '/api/v1/repos/fixture/source?x=1',
            '/api/v1/repos/fixture/source?service=x&service=y', '/api/v1/repos//fixture/source',
            '//api/v1/version', '/api/v1/../v1/version', '/api/v1/./version',
            '/api/v1/version#suffix', '/api/v1/version\\suffix', 'http://provider:3000/api/v1/version',
            GIT + '/info/refs?service=git-receive-pack&service=git-upload-pack',
            '/fixture/source.wiki.git/info/refs?service=git-upload-pack')
        for method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'):
            for target in targets:
                with self.subTest(method=method, target=target), self.assertRaises(Denied):
                    classify(method, target, HEADERS, b'', INTENT)
        # The same admitted read address must not become a native PATCH/DELETE
        # surface merely because its GET route is recognized.
        for method in ('POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'):
            for target in ('/api/v1/version', '/api/v1/repos/fixture/source',
                           '/api/v1/repos/fixture/source/branches/main'):
                with self.subTest(method=method, target=target), self.assertRaises(Denied):
                    classify(method, target, HEADERS, b'', INTENT)
        with self.assertRaises(Denied):
            classify('GET', GIT + '/info/refs?service=git-receive-pack',
                     HEADERS | {'Git-Protocol': 'version=2'}, b'', INTENT)

    def test_overrides_authority_and_framing(self):
        for header in ('X-HTTP-Method-Override', 'X-Method-Override', 'X-HTTP-Method',
                       'Transfer-Encoding', 'Forwarded', 'X-Forwarded-Host',
                       'X-Original-URL', 'X-Rewrite-URL', 'Sudo'):
            with self.subTest(header=header), self.assertRaises(Denied):
                classify('GET', '/api/v1/version', HEADERS | {header: 'x'}, b'', INTENT)
        for headers, body in (({}, b''), (HEADERS, b'x'), ({'Authorization': 'token '}, b''),
                              ({'Authorization': 'Basic Og=='}, b'')):
            with self.assertRaises(Denied):
                classify('GET', '/api/v1/version', headers, body, INTENT)

    def test_receive(self):
        headers = HEADERS | {'Content-Type': 'application/x-git-receive-pack-request'}
        self.assertEqual(classify('POST', GIT + '/git-receive-pack', headers, receive(), INTENT), 'one-declared-branch-receive')
        self.assertEqual(classify('POST', GIT + '/git-receive-pack', headers,
            receive(caps=' report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.5.(Apple.Git-154)'), INTENT), 'one-declared-branch-receive')
        invalid = (receive(new='0' * 40), receive(old='3' * 40), receive(new='3' * 40),
                   receive(ref='refs/heads/main'), receive(ref='refs/tags/v1'),
                   receive(ref='refs/for/main'), receive(caps='push-options'),
                   receive(caps='report-status unknown'), receive(caps='  report-status'),
                   receive(caps='report-status\tquiet'), receive(caps=''), receive(extra=b'0008abcd'),
                   b'zzzzinvalid', b'0000', receive().replace(b'PACK', b'xxxx', 1))
        for body in invalid:
            with self.subTest(body=body[:4]), self.assertRaises(Denied):
                classify('POST', GIT + '/git-receive-pack', headers, body, INTENT)
        for headers in (HEADERS, headers | {'Git-Protocol': 'version=2'}):
            with self.assertRaises(Denied):
                classify('POST', GIT + '/git-receive-pack', headers, receive(), INTENT)


if __name__ == '__main__':
    unittest.main()
