#!/usr/bin/env python3
"""Drop an actual native Gitea creation response and prove durable uncertainty.

Requires explicit coordination before using the supplied dedicated PostgreSQL
database. Its public schema must be empty; unit-test random schemas are separate.
The adjacent private container-name marker identifies that disposable database.
Normal Golf/configuration are untouched. The supplied database remains owned by
the caller; this script removes its ordinary Gitea users/repos and child servers.
"""
import argparse
import base64
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from urllib.parse import unquote, urlsplit
import uuid

sys.dont_write_bytecode = True
import smoke

STAGE = 'initialization'
UNKNOWN = 'REPOSITORY_CREATION_STATE_OUTCOME_UNKNOWN'


def stage(name):
    global STAGE
    STAGE = name
    print('CHECK: ' + name, flush=True)


def private_text(path):
    metadata = path.lstat()
    assert stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid()
    assert stat.S_IMODE(metadata.st_mode) & 0o077 == 0
    return path.read_text().strip()


def available_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-binary', type=Path, required=True)
    parser.add_argument('--database-url-file', type=Path, required=True)
    args = parser.parse_args()
    binary = args.server_binary.resolve()
    assert binary.is_file() and (smoke.ROOT / 'web/dist/index.html').is_file()
    dsn = private_text(args.database_url_file)
    pg = urlsplit(dsn)
    assert pg.scheme in {'postgres', 'postgresql'} and pg.hostname in {'127.0.0.1', 'localhost'}
    assert pg.port and pg.username and pg.path == '/postgres'
    container = private_text(args.database_url_file.parent / 'container-name')
    assert container.startswith('golf-') and all(letter.isalnum() or letter in '-_' for letter in container)
    inspected = json.loads(smoke.command('docker', 'inspect', container))[0]
    binding = inspected['HostConfig']['PortBindings']['5432/tcp']
    assert len(binding) == 1 and binding[0]['HostIp'] == '127.0.0.1' and int(binding[0]['HostPort']) == pg.port
    pg_environment = dict(os.environ, PGPASSWORD=unquote(pg.password or ''))
    result = subprocess.run(['docker', 'exec', '-e', 'PGPASSWORD', container, 'psql',
        '-h', '127.0.0.1', '-U', unquote(pg.username), '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1',
        '-c', "SELECT current_setting('server_version_num'), count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S');"],
        env=pg_environment, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0 and result.stdout.strip() == '180004|0', 'Use a fresh dedicated PostgreSQL 18.4 public schema'
    assert smoke.request(smoke.client(), 'GET', smoke.GITEA + '/api/v1/version')['version'] == '1.27.3'

    # ponytail: one fixed provider and one fault, not a configurable gateway.
    # The proxy sees real scoped credentials but never logs headers or bodies.
    counts = {'posts': 0, 'accepted': 0, 'native_id': None, 'error': False}
    count_lock = threading.Lock()

    class Proxy(ThreadingHTTPServer):
        daemon_threads = False

        def handle_error(self, *_):
            with count_lock:
                counts['error'] = True

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(12)

        def do_GET(self):
            self.forward()

        def do_POST(self):
            self.forward()

        def forward(self):
            upstream = HTTPConnection('127.0.0.1', 3001, timeout=10)
            try:
                parsed = urlsplit(self.path)
                assert not parsed.scheme and not parsed.netloc and self.path.startswith('/api/v1/')
                assert not self.headers.get('Transfer-Encoding')
                length = int(self.headers.get('Content-Length', '0'))
                assert 0 <= length <= 16384
                body = self.rfile.read(length)
                assert len(body) == length
                headers = {name: self.headers[name] for name in ['Authorization', 'Content-Type', 'Accept'] if name in self.headers}
                is_create = self.command == 'POST' and self.path == '/api/v1/user/repos'
                assert self.command == 'GET' or is_create
                if is_create:
                    with count_lock:
                        counts['posts'] += 1
                upstream.request(self.command, self.path, body=body or None, headers=headers)
                response = upstream.getresponse()
                data = response.read((2 << 20) + 1)
                assert len(data) <= 2 << 20
                if is_create:
                    assert response.status == 201, 'Expected actual native repository creation'
                    native = json.loads(data)
                    assert isinstance(native['id'], int) and native['id'] > 0 and native['private'] is True
                    with count_lock:
                        counts['accepted'] += 1
                        counts['native_id'] = native['id']
                    # Native Gitea has returned its real 201. Send no HTTP status,
                    # headers or body to Golf: the provider acknowledgment is lost.
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.send_response(response.status)
                for name in ['Content-Type', 'Link', 'X-Total-Count']:
                    if response.getheader(name):
                        self.send_header(name, response.getheader(name))
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception:
                with count_lock:
                    counts['error'] = True
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            finally:
                upstream.close()

    proxy = Proxy(('127.0.0.1', 0), Handler)
    proxy_thread = threading.Thread(target=proxy.serve_forever, kwargs={'poll_interval': 0.1}, daemon=True)
    original_origin = smoke.GOLF
    smoke.GOLF = 'http://127.0.0.1:' + str(available_port())
    proxy_origin = 'http://127.0.0.1:' + str(proxy.server_port)
    environment = {name: value for name, value in os.environ.items()
                   if not name.startswith(('GOLF_', 'GITEA_')) and name != 'DATABASE_URL'}
    key_material = base64.b64encode(secrets.token_bytes(32)).decode()
    environment.update(DATABASE_URL=dsn, GOLF_PUBLIC_URL=smoke.GOLF,
        GOLF_LISTEN_ADDR=urlsplit(smoke.GOLF).netloc, GITEA_URL=proxy_origin,
        GOLF_ENCRYPTION_KEY=key_material, GOLF_ALLOW_INSECURE_COOKIES='true',
        GOLF_WEB_DIR=str(smoke.ROOT / 'web/dist'))
    process, actors = None, []
    prefix = 'golf-create-fault-' + secrets.token_hex(5)
    proxy_started = False
    forbidden = [dsn, key_material]

    def stop():
        nonlocal process
        if process:
            process.terminate()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            process = None

    def start(log):
        nonlocal process
        assert process is None
        process = subprocess.Popen([str(binary)], cwd=smoke.ROOT, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            assert process.poll() is None, 'Private Golf process exited during startup'
            try:
                smoke.request(smoke.client(), 'GET', smoke.GOLF + '/readyz')
                return
            except (AssertionError, OSError):
                time.sleep(0.25)
        raise AssertionError('Private Golf startup deadline exceeded')

    def rpc(actor, procedure, payload=None, **kwargs):
        return smoke.rpc(actor['session'], procedure, payload, **kwargs)

    def unchanged(result, initial=None):
        record = result['creation']
        assert record['state'] == UNKNOWN and not record.get('repositoryId') and not result.get('repository')
        assert record['idempotencyKey'] == operation_key and record['requestedName'] == 'lost-native-response'
        assert record['private'] is True
        if initial:
            assert record == initial
        with count_lock:
            assert counts == {'posts': 1, 'accepted': 1, 'native_id': native_id, 'error': False}
        return record

    try:
        with tempfile.TemporaryDirectory(prefix='golf-create-fault-') as temporary:
            directory = Path(temporary)
            directory.chmod(0o700)
            log_path = directory / 'server.log'
            with log_path.open('xb') as log:
                log_path.chmod(0o600)
                proxy_thread.start()
                proxy_started = True
                stage('start private Golf against dedicated PostgreSQL and fixed native proxy')
                start(log)
                for role in ['owner', 'other']:
                    name = prefix + '-' + role
                    smoke.admin('create', '--username', name, '--email', name + '@example.invalid',
                                '--random-password', '--random-password-length', '32', '--must-change-password=false')
                    actor = {'name': name, 'session': None}
                    actors.append(actor)
                    actor['token'] = smoke.admin('generate-access-token', '--username', name,
                        '--token-name', prefix, '--scopes', 'write:user,write:repository', '--raw')
                    forbidden.append(actor['token'])
                    actor['session'] = smoke.client()
                    rpc(actor, 'SessionService/LoginWithGiteaToken', {'token': actor['token']})
                owner, other = actors
                operation_key = str(uuid.uuid4())
                payload = {'name': 'lost-native-response', 'description': 'Native provider acknowledgment loss fixture',
                           'private': True, 'idempotencyKey': operation_key}
                stage('actual native creation accepted before provider response is discarded')
                result = rpc(owner, 'RepositoryService/CreateRepository', payload)
                with count_lock:
                    native_id = counts['native_id']
                assert native_id is not None
                initial = unchanged(result)
                native = smoke.provider(owner['token'], 'GET', 'repos/' + owner['name'] + '/' + payload['name'])
                assert native['id'] == native_id and native['description'] == payload['description'] and native['private'] is True
                for _ in range(3):
                    unchanged(rpc(owner, 'RepositoryService/CreateRepository', payload), initial)
                    unchanged(rpc(owner, 'RepositoryService/GetRepositoryCreation', {'idempotencyKey': operation_key}), initial)
                rpc(owner, 'RepositoryService/CreateRepository', {**payload, 'description': 'changed'}, expected=400, code='failed_precondition')
                missing = rpc(other, 'RepositoryService/GetRepositoryCreation', {'idempotencyKey': str(uuid.uuid4())}, expected=404)
                assert rpc(other, 'RepositoryService/GetRepositoryCreation', {'idempotencyKey': operation_key}, expected=404) == missing
                smoke.provider(other['token'], 'GET', 'repos/' + owner['name'] + '/' + payload['name'], expected=404)
                print('PASS: genuine native201 lost to Golf, durable UNKNOWN, own-account privacy and exact one observed provider POST', flush=True)
                stage('restart private Golf without changing proxy, key, database or caller session')
                stop()
                start(log)
                unchanged(rpc(owner, 'RepositoryService/GetRepositoryCreation', {'idempotencyKey': operation_key}), initial)
                unchanged(rpc(owner, 'RepositoryService/CreateRepository', payload), initial)
                assert smoke.provider(owner['token'], 'GET', 'repos/' + owner['name'] + '/' + payload['name'])['id'] == native_id
                current = next(row['id'] for row in rpc(owner, 'SessionService/ListSessions')['sessions'] if row.get('current'))
                rpc(owner, 'SessionService/RevokeSession', {'sessionId': current})
                rpc(owner, 'RepositoryService/GetRepositoryCreation', {'idempotencyKey': operation_key}, expected=401)
                rpc(owner, 'RepositoryService/CreateRepository', payload, expected=401)
                with count_lock:
                    assert counts == {'posts': 1, 'accepted': 1, 'native_id': native_id, 'error': False}
                print('PASS: UNKNOWN survives actual backend restart without resend/adoption; revoked session cannot inspect or replay', flush=True)
                for actor in actors:
                    rpc(actor, 'SessionService/Logout')
                stop()
                log.flush()
                assert not any(secret.encode() in log_path.read_bytes() for secret in forbidden), 'Private server logged credential material'
    finally:
        stop()
        if proxy_started:
            proxy.shutdown()
        proxy.server_close()
        if proxy_started:
            proxy_thread.join(timeout=15)
            assert not proxy_thread.is_alive(), 'Proxy did not stop'
        failures = []
        for actor in reversed(actors):
            try:
                smoke.admin('delete', '--username', actor['name'], '--purge')
            except Exception:
                failures.append('provider cleanup')
        smoke.GOLF = original_origin
        assert not failures, 'Native fault fixture cleanup failed'
    print('PASS: private servers/logs and native users/repos removed; supplied disposable database retained for its owner', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        locations = ' > '.join(str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)
                               if Path(frame.filename).name == Path(__file__).name)
        raise SystemExit('Native creation fault qualification failed at ' + STAGE + ' (' + locations + '); diagnostics withheld')
