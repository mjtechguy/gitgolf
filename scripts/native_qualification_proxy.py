"""Control adapter for native-qualification-proxy.go; fixture transport only.

The caller owns fresh Compose start/cleanup. start() prepares RAM state; it does
not run Docker or bind a listener. After Compose up, call ready(). Publish only
the control port on 127.0.0.1; Golf uses http://native-qualification-proxy:8081
inside the same private fresh network. Feed environment() into the caller's
subprocess environment, never its manifest/YAML/stdout. close() captures state
and stops the adapter BEFORE Compose down; the final snapshot remains readable.
Source self-checks do not establish actual native effects or served readiness.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import secrets
import time
import urllib.error
import urllib.request
import urllib.parse

PROJECT = re.compile(r'golf-(?:rules49|access48)-[a-f0-9]{10}')
NONCE_HEADER = 'X-Native-Qualification-Nonce'
NATIVE_DESTINATION = 'http://gitea:3000'
SERVICE_NAME = 'native-qualification-proxy'
METHODS = {'POST', 'PATCH', 'PUT', 'DELETE'}
CATEGORIES = {'authority', 'repository', 'branch_protections', 'tag_protections', 'collaborator'}
FAILURES = {prefix + kind for prefix in ('preheaders_', 'response_', 'downstream_') for kind in ('timeout', 'cancelled', 'disconnected', 'transport')} | {'response_bound', 'drop_hijack'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def owned_write(project: str, method: str, path: str) -> bool:
    if re.search(r'%(?![a-fA-F0-9]{2})', path):
        return False
    try:
        decoded = urllib.parse.unquote_to_bytes(path).decode('utf-8', errors='strict')
    except UnicodeError:
        return False
    if '\\' in decoded or any(segment in {'.', '..'} for segment in decoded.split('/')) or any(ord(c) < 32 or ord(c) == 127 for c in decoded):
        return False
    base = r'/api/v1/repos/' + re.escape(project) + r'-(?:owner|org)/[A-Za-z0-9_-]+'
    return bool(method == 'PATCH' and re.fullmatch(base, path)
                or method in {'POST', 'PATCH', 'DELETE'} and re.fullmatch(base + r'/(?:branch_protections|tag_protections)(?:/[^/?]+)?', path)
                or method in {'PUT', 'DELETE'} and re.fullmatch(base + r'/collaborators/' + re.escape(project) + r'-(?:recipient|directadmin|outsider|golfadmin|teamadmin)', path))


def valid_fault(project: str, value: dict) -> bool:
    if set(value) not in ({'method', 'path', 'status'}, {'method', 'path', 'status', 'ruleName'}):
        return False
    method, path, status = value.get('method'), value.get('path'), value.get('status')
    if not isinstance(method, str) or not isinstance(path, str) or not owned_write(project, method, path) or type(status) is not int:
        return False
    return bool(method == 'POST' and status == 201 and path.endswith('/branch_protections') and value.get('ruleName') == 'unknown/*'
                or method == 'PUT' and status == 204 and '/collaborators/' in path and value.get('ruleName', '') == '')


def checked_snapshot(value: object, project: str) -> dict:
    assert isinstance(value, dict) and set(value) == {'project', 'nativeDestination', 'counts', 'observations', 'forwardRequestCount', 'lost', 'failures', 'callerCancelled', 'armed'}, 'Safe control snapshot shape mismatch'
    assert value['project'] == project and value['nativeDestination'] == NATIVE_DESTINATION, 'Control fixture identity mismatch'
    for key in ('forwardRequestCount', 'lost', 'failures', 'callerCancelled'):
        assert type(value[key]) is int and 0 <= value[key] <= (1 << 53) - 1, 'Control counter mismatch'
    assert value['lost'] <= 1 and (value['armed'] is None or isinstance(value['armed'], dict) and valid_fault(project, value['armed'])), 'Control fault identity mismatch'
    counts, observations = value['counts'], value['observations']
    assert isinstance(counts, list) and len(counts) <= 256 and isinstance(observations, list) and len(observations) <= 64, 'Control collection bound mismatch'
    pairs = set()
    for row in counts:
        assert isinstance(row, dict) and set(row) == {'method', 'path', 'count'}, 'Mutation counter shape mismatch'
        assert isinstance(row['method'], str) and isinstance(row['path'], str) and len(row['path']) <= 4096 and owned_write(project, row['method'], row['path']) and type(row['count']) is int and 1 <= row['count'] <= (1 << 53) - 1, 'Mutation counter binding mismatch'
        pair = row['method'], row['path']
        assert pair not in pairs, 'Duplicate mutation counter'; pairs.add(pair)
    for row in observations:
        assert isinstance(row, dict) and {'method', 'category', 'elapsedMs'} <= set(row) <= {'method', 'category', 'elapsedMs', 'status', 'bytes', 'failure', 'callerCancelled'}, 'Observation shape mismatch'
        assert row['method'] in METHODS | {'GET'} and row['category'] in CATEGORIES and type(row['elapsedMs']) is int and row['elapsedMs'] >= 0, 'Observation metadata mismatch'
        assert 'status' not in row or type(row['status']) is int and 100 <= row['status'] <= 599, 'Observation status mismatch'
        assert 'bytes' not in row or type(row['bytes']) is int and 0 <= row['bytes'] <= 2 << 20, 'Observation byte bound mismatch'
        assert 'failure' not in row or row['failure'] in FAILURES, 'Unknown transport failure category'
        if 'callerCancelled' in row:
            assert row['callerCancelled'] is True and row['method'] == 'GET' and row.get('failure') in {'preheaders_cancelled','response_cancelled'}, 'Unverified/write cancellation was discounted'
        if row.get('callerCancelled') and row['failure'] == 'preheaders_cancelled':
            assert 'status' not in row and 'bytes' not in row, 'Pre-header caller abort cannot claim a native receipt'
    assert sum(bool(row.get('callerCancelled')) for row in observations) <= value['callerCancelled'], 'Caller cancellation counter mismatch'
    assert sum(row['count'] for row in counts) <= value['forwardRequestCount'], 'Control aggregate count mismatch'
    assert value['callerCancelled'] <= value['forwardRequestCount'] and sum(row.get('callerCancelled', False) for row in observations) <= value['callerCancelled'], 'Caller cancellation count mismatch'
    return value


class NativeProxy:
    """Exact-owned Compose service + nonce control, no native mocks/replays."""
    def __init__(self, port: int, project: str):
        assert type(port) is int and 1024 <= port <= 65535 and PROJECT.fullmatch(project), 'Owned control configuration required'
        self.port, self.project = port, project
        self.control_url = f'http://127.0.0.1:{port}'
        self._nonce = secrets.token_hex(32)
        # The RAM nonce is sent only to this loopback control endpoint, even
        # when the invoking shell has HTTP proxy environment variables.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self._started = False
        self._closed = False
        self._final = None
        self.cleanup_failed = False

    def environment(self) -> dict[str, str]:
        """Inject into the caller's private subprocess environment, not files."""
        return {'NATIVE_QUALIFICATION_NONCE': self._nonce}

    def compose_service(self, image: str, binary: Path) -> dict:
        assert re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'Exact cached image identity required'
        binary = binary.absolute()
        assert binary.is_file() and not binary.is_symlink() and binary.stat().st_size <= 64 << 20, 'Owned compiled binary required'
        with binary.open('rb') as file:
            assert file.read(4) == b'\x7fELF', 'Linux binary required'
        return {'image': image, 'pull_policy': 'never', 'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                'entrypoint': ['/usr/local/bin/native-qualification-proxy'], 'volumes': [f'{binary}:/usr/local/bin/native-qualification-proxy:ro'],
                'ports': [f'127.0.0.1:{self.port}:8082'], 'expose': ['8081'], 'depends_on': {'gitea': {'condition': 'service_started'}},
                'environment': {'NATIVE_QUALIFICATION_PROJECT': self.project, 'NATIVE_QUALIFICATION_NONCE': '${NATIVE_QUALIFICATION_NONCE:?}'}}

    def start(self):
        assert not self._closed
        self._started = True
        return self

    def ready(self, timeout: float = 15):
        """Read-only startup polling. No control arm or native write is retried."""
        assert self._started and not self._closed and 0 < timeout <= 30
        until = time.monotonic() + timeout
        while True:
            try:
                result = self._request('GET', '/health')
                assert result == {'state': 'ready', 'project': self.project, 'nativeDestination': NATIVE_DESTINATION}, 'Control readiness identity mismatch'
                return
            except urllib.error.URLError:
                if time.monotonic() >= until:
                    raise AssertionError('Owned proxy control did not become ready') from None
                time.sleep(0.1)

    def _request(self, method: str, path: str, payload=None):
        assert self._started and not self._closed and (method, path) in {('GET', '/health'), ('GET', '/state'), ('POST', '/arm'), ('POST', '/stop')}
        request = urllib.request.Request(self.control_url + path, data=None if payload is None else json.dumps(payload).encode(), method=method,
                                         headers={NONCE_HEADER: self._nonce, 'Content-Type': 'application/json'})
        try:
            response = self._opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            raise AssertionError(f'Owned proxy control refused HTTP {error.code}') from None
        with response:
            raw = response.read((512 << 10) + 1)
            assert response.status == 200 and response.headers.get('Cache-Control') == 'no-store' and len(raw) <= 512 << 10, 'Safe control response mismatch'
            return json.loads(raw)

    def snapshot(self):
        if self._closed:
            assert self._final is not None, 'No confirmed final proxy snapshot'
            return self._final
        return checked_snapshot(self._request('GET', '/state'), self.project)

    @property
    def counts(self):
        return {(row['method'], row['path']): row['count'] for row in self.snapshot()['counts']}

    @property
    def lost(self):
        return self.snapshot()['lost']

    @property
    def failures(self):
        return self.snapshot()['failures']

    @property
    def caller_cancelled(self):
        return self.snapshot()['callerCancelled']

    @property
    def armed(self):
        value = self.snapshot()['armed']
        return None if value is None else (value['method'], value['path'])

    def arm(self, *args):
        if len(args) == 1:
            value = {'method': 'PUT', 'path': args[0], 'status': 204}
        else:
            assert len(args) == 3, 'Provide one collaborator path or exact POST/path/rule pattern'
            value = {'method': args[0], 'path': args[1], 'status': 201, 'ruleName': args[2]}
        assert valid_fault(self.project, value), 'Exact owned accepted-response fault required'
        # A lost control acknowledgement does not authorize a second arm.
        assert self._request('POST', '/arm', value) == {'state': 'armed'}, 'Fault arm acknowledgement mismatch'

    def total(self, repository):
        name = self._repository_name(repository)
        prefix = '/api/v1/repos/' + name
        return sum(count for (_, path), count in self.counts.items() if path == prefix or path.startswith(prefix + '/'))

    def count(self, repository, recipient):
        name = self._repository_name(repository)
        assert isinstance(recipient, dict) and isinstance(recipient.get('name'), str) and re.fullmatch(re.escape(self.project) + r'-(?:recipient|directadmin|outsider|golfadmin|teamadmin)', recipient['name']), 'Owned recipient required'
        path = '/api/v1/repos/' + name + '/collaborators/' + recipient['name']
        counts = self.counts
        return sum(counts.get((method, path), 0) for method in ('PUT', 'DELETE'))

    def _repository_name(self, repository):
        assert isinstance(repository, dict)
        if isinstance(repository.get('key'), dict):
            repository = repository['key']
        name = repository.get('name')
        owner = repository.get('owner')
        if isinstance(owner, str):
            name = owner + '/' + name if isinstance(name, str) else None
        assert isinstance(name, str) and re.fullmatch(re.escape(self.project) + r'-(?:owner|org)/[A-Za-z0-9_-]+', name), 'Owned repository required'
        return name

    def close(self):
        if self._closed or not self._started:
            return
        self._final = self.snapshot()
        assert self._request('POST', '/stop', {}) == {'state': 'stopping'}, 'Control stop acknowledgement mismatch'
        self._closed = True

    stop = close

    def __enter__(self):
        return self.start()

    def __exit__(self, kind, *args):
        if kind is None:
            self.close()
        else:
            # Preserve the original failure; caller independently records and
            # removes exact fresh Compose resources even if control is gone.
            try:
                self.close()
            except Exception:
                self.cleanup_failed = True


def self_check():
    project = 'golf-rules49-0123456789'
    path = '/api/v1/repos/' + project + '-owner/rules/branch_protections'
    assert owned_write(project, 'POST', path) and not owned_write(project, 'POST', path + '?extra=1') and not owned_write(project, 'DELETE', '/api/v1/repos/foreign/rules')
    assert valid_fault(project, {'method': 'POST', 'path': path, 'status': 201, 'ruleName': 'unknown/*'})
    assert not valid_fault(project, {'method': 'POST', 'path': path, 'status': 200, 'ruleName': 'unknown/*'})
    value = {'project': project, 'nativeDestination': NATIVE_DESTINATION, 'counts': [{'method': 'POST', 'path': path, 'count': 1}], 'observations': [{'method': 'POST', 'category': 'branch_protections', 'status': 201, 'elapsedMs': 1}], 'forwardRequestCount': 1, 'lost': 1, 'failures': 0, 'callerCancelled': 0, 'armed': None}
    assert checked_snapshot(value, project) is value
    for patch in ({'lost': 2}, {'forwardRequestCount': 0}, {'counts': [value['counts'][0], value['counts'][0]]}, {'observations': [{'method': 'GET', 'category': 'authority', 'elapsedMs': 0, 'failure': 'private response text'}]}):
        try:
            checked_snapshot({**value, **patch}, project)
        except AssertionError:
            pass
        else:
            raise AssertionError('Malformed control metadata accepted')
    proxy = NativeProxy(39001, project)
    aborted = {**value,'callerCancelled':1,'observations':[{'method':'GET','category':'authority','elapsedMs':1,'failure':'preheaders_cancelled','callerCancelled':True}]}
    checked_snapshot(aborted,project)
    for patch in ({'callerCancelled':0}, {'callerCancelled':2}, {'observations':[{**aborted['observations'][0],'method':'PUT'}]}, {'observations':[{**aborted['observations'][0],'failure':'preheaders_timeout'}]}, {'observations':[{**aborted['observations'][0],'status':200}]}, {'observations':[{**aborted['observations'][0],'callerCancelled':False}]}):
        try:checked_snapshot({**aborted,**patch},project)
        except AssertionError:pass
        else:raise AssertionError('Unverified/write/deadline caller cancellation accepted')
    assert proxy._repository_name({'owner': project + '-owner', 'name': 'rules'}) == project + '-owner/rules'
    assert proxy._nonce not in json.dumps(value)
    assert proxy.environment()['NATIVE_QUALIFICATION_NONCE'] == proxy._nonce
    print('PASS: pure exact-owned control/fault/counter bounds; no Docker, native calls or listeners')


if __name__ == '__main__':
    import sys
    assert sys.argv[1:] == ['--self-check'], 'Only --self-check is a standalone command'
    self_check()
