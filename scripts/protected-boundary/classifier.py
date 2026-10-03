#!/usr/bin/env python3
"""Disposable operation classifier. NOT a production admission/publisher service."""
import base64
import binascii
import json
import re
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 2 << 20
MAX_RESPONSE = 8 << 20
SHA = re.compile(r'[0-9a-f]{40}')
SAFE_CAPABILITIES = {'report-status', 'report-status-v2', 'side-band-64k', 'quiet',
                     'ofs-delta', 'object-format=sha1'}


class Denied(ValueError):
    pass


def classify(method, target, headers, body, intent):
    """Recognize exact raw origin-form targets; do not decode/rewrite aliases."""
    if (not target.startswith('/') or any(c in target for c in '%\\#\r\n\t')
            or '//' in target or any(p in ('.', '..') for p in target.split('/'))):
        raise Denied('noncanonical target')
    if any(k.lower() in ('x-http-method-override', 'x-method-override', 'x-http-method',
                         'transfer-encoding', 'forwarded', 'x-forwarded-host',
                         'x-original-url', 'x-rewrite-url', 'sudo') for k in headers):
        raise Denied('unqualified request authority or framing')
    authorization = headers.get('Authorization', '')
    if authorization.startswith('token '):
        if not SHA.fullmatch(authorization[6:]):
            raise Denied('fixture PAT format required')
    elif authorization.startswith('Bearer '):
        # Native auth owns signature/expiry/scope validation. This grammar is
        # only a bounded header format, never evidence that a token is valid.
        bearer = authorization[7:]
        if len(bearer) > 8192 or not re.fullmatch(r'[A-Za-z0-9._~+/-]+=*', bearer):
            raise Denied('Bearer credential format')
        if not target.startswith('/api/v1/'):
            raise Denied('Bearer Git transport not qualified')
    elif authorization.startswith('Basic '):
        try:
            username, password = base64.b64decode(authorization[6:], validate=True).decode('ascii').split(':', 1)
        except (ValueError, UnicodeError, binascii.Error):
            raise Denied('Basic credential format') from None
        if not username or not password:
            raise Denied('empty Basic credential')
    else:
        raise Denied('credential required')
    repo = '/api/v1/repos/' + intent['owner'] + '/' + intent['repository']
    git = '/' + intent['owner'] + '/' + intent['repository'] + '.git'
    if method == 'GET' and not body:
        if target == '/api/v1/user':
            return 'classified-current-user-read'
        if target in ('/api/v1/version', repo, repo + '/branches/main'):
            return 'classified-metadata-read'
        if target == git + '/info/refs?service=git-upload-pack':
            return 'git-upload-advertisement'
        if target == git + '/info/refs?service=git-receive-pack':
            if headers.get('Git-Protocol'):
                raise Denied('receive protocol extension')
            return 'git-receive-advertisement'
    if method == 'POST' and target == git + '/git-upload-pack':
        if headers.get('Content-Type') != 'application/x-git-upload-pack-request':
            raise Denied('upload content type')
        return 'git-upload-read'
    if method != 'POST' or target != git + '/git-receive-pack':
        raise Denied('operation not admitted')
    if headers.get('Content-Type') != 'application/x-git-receive-pack-request' or headers.get('Git-Protocol'):
        raise Denied('receive content type/protocol')
    # First pkt-line is the sole update; next must be flush, then PACK. Thus tags,
    # multiple updates, deletion, push-options and alternate ref forms never dispatch.
    if len(body) < 12 or not re.fullmatch(b'[0-9a-f]{4}', body[:4]):
        raise Denied('receive framing')
    length = int(body[:4], 16)
    if length < 4 or body[length:length + 8] != b'0000PACK':
        raise Denied('receive must contain exactly one update and a pack')
    try:
        command, capabilities = body[4:length].decode('ascii').rstrip('\n').split('\0')
        old, new, ref = command.split(' ')
    except (ValueError, UnicodeError):
        raise Denied('receive command') from None
    if not SHA.fullmatch(old) or not SHA.fullmatch(new) or new == '0' * 40:
        raise Denied('receive object identity')
    # Git 2.39 send-pack deliberately prefixes cap_buf with one space after NUL.
    # Admit that pinned framing, while rejecting other control/spacing variants.
    if not re.fullmatch(r' ?[!-~]+(?: [!-~]+)*', capabilities):
        raise Denied('receive capability framing')
    for cap in capabilities.lstrip(' ').split(' '):
        if cap not in SAFE_CAPABILITIES and not re.fullmatch(r'agent=git/[0-9A-Za-z.()+-]+', cap):
            raise Denied('receive capability not qualified')
    if (old, new, ref) != (intent['old'], intent['new'], 'refs/heads/' + intent['branch']):
        raise Denied('receive differs from fixture intent')
    return 'one-declared-branch-receive'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    receive_lock = threading.Lock()
    received = False

    def log_message(self, *args):
        pass  # Never log credentials, path payloads or private provider responses.

    def respond(self, status, body, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        self.close_connection = True

    def dispatch(self):
        try:
            intent = json.loads(Path('/fixture/intent.json').read_text())
            # BaseHTTPRequestHandler normalizes leading // before exposing path.
            # Compare the original request line so aliases never gain admission.
            if self.requestline != self.command + ' ' + self.path + ' HTTP/1.1':
                raise Denied('request line normalization/version')
            if self.headers.get('Host') != intent['host']:
                raise Denied('host not admitted')
            for key in self.headers:
                if len(self.headers.get_all(key)) != 1:
                    raise Denied('duplicate headers')
            if self.headers.get('Transfer-Encoding'):
                raise Denied('transfer framing')
            size_text = self.headers.get('Content-Length', '0')
            if not re.fullmatch(r'0|[1-9][0-9]{0,7}', size_text):
                raise Denied('content length')
            size = int(size_text)
            if size > MAX_BODY:
                raise Denied('body bound')
            self.connection.settimeout(10)
            body = self.rfile.read(size)
            if len(body) != size:
                raise Denied('truncated body')
            operation = classify(self.command, self.path, self.headers, body, intent)
            if self.path == '/api/v1/version':
                credential = urllib.request.Request('http://provider:3000/api/v1/user',
                    headers={'Authorization': self.headers['Authorization']})
                with urllib.request.build_opener(NoRedirect()).open(credential, timeout=10) as response:
                    if response.status != 200:
                        raise Denied('credential rejected')
            if operation == 'one-declared-branch-receive':
                binding = urllib.request.Request('http://provider:3000/api/v1/repos/' +
                    intent['owner'] + '/' + intent['repository'],
                    headers={'Authorization': self.headers['Authorization']})
                with urllib.request.build_opener(NoRedirect()).open(binding, timeout=10) as response:
                    raw = response.read(MAX_BODY + 1)
                    if len(raw) > MAX_BODY:
                        raise Denied('repository receipt bound')
                    repository = json.loads(raw)
                if (repository.get('id'), repository.get('owner', {}).get('id')) != (intent['repository_id'], intent['owner_id']):
                    raise Denied('repository identity changed')
                with Handler.receive_lock:
                    if Handler.received:
                        raise Denied('fixture receive already dispatched')
                    Handler.received = True
            headers = {k: self.headers[k] for k in ('Authorization', 'Content-Type', 'Git-Protocol') if k in self.headers}
            request = urllib.request.Request('http://provider:3000' + self.path,
                method=self.command, data=body if self.command == 'POST' else None, headers=headers)
            try:
                response = urllib.request.build_opener(NoRedirect()).open(request, timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                result = response.read(MAX_RESPONSE + 1)
                if len(result) > MAX_RESPONSE:
                    raise Denied('response bound')
                self.respond(response.status, result, response.headers.get('Content-Type', 'application/octet-stream'))
        except Denied as error:
            print('DENIED: ' + str(error), flush=True)
            self.respond(403, b'{"error":"fixture operation denied; no protected authority"}')
        except (OSError, ValueError):
            self.respond(403, b'{"error":"fixture operation denied; no protected authority"}')

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = dispatch


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
