#!/usr/bin/env python3
"""Exercise the local Compose stack; creates then purges isolated test users.

Run after docker compose up -d --build. --restart also restarts services and
briefly stops Gitea to verify persistence and outage reporting on this dev stack.
Credentials stay in process memory and are never printed.
"""
import argparse
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
GOLF = 'http://localhost:8080'
GITEA = 'http://localhost:3001'


def command(*args, env=None, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed (output withheld to protect credentials)')
    return result.stdout.strip()


def admin(*args):
    return command('docker', 'compose', 'exec', '-T', 'gitea', 'gitea',
                   '--config', '/etc/gitea/app.ini', 'admin', 'user', *args)


def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(opener, method, url, payload=None, headers=None, expected=200):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={'Origin': GOLF, 'Content-Type': 'application/json', **(headers or {})})
    try:
        response = opener.open(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        assert response.status == expected, f'{method} {url}: {response.status}, expected {expected}'
        return json.loads(raw) if raw else None


def ready():
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            request(client(), 'GET', GOLF + '/readyz')
            return
        except (AssertionError, OSError):
            time.sleep(0.5)
    raise RuntimeError('Stack did not become ready within 45 seconds')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart', action='store_true', help='restart/stop local Compose services for recovery checks')
    args = parser.parse_args()
    ready()
    users = []
    suffix = secrets.token_hex(4)
    try:
        for label in ('alice', 'bob'):
            name = f'golf-check-{label}-{suffix}'
            password = secrets.token_urlsafe(32)
            admin('create', '--username', name, '--email', name + '@example.invalid',
                  '--password', password, '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', 'golf-local-check',
                          '--scopes', 'write:user,write:repository', '--raw')
            session = client()
            identity = request(session, 'POST', GOLF + '/api/session', {'token': token})['user']
            assert identity['login'] == name
            if label == 'alice':
                alice, alice_token, alice_password = session, token, password
                alice_name = name
            else:
                bob = session
        request(client(), 'GET', GOLF + '/api/repositories', expected=401)
        request(alice, 'POST', GOLF + '/api/repositories', {'name': 'rejected', 'private': True},
                headers={'Origin': 'https://invalid.example'}, expected=403)
        repo = request(alice, 'POST', GOLF + '/api/repositories',
                       {'name': 'smoke-private', 'description': 'Temporary local verification', 'private': True}, expected=201)['repository']
        assert repo['private'] is True
        full_name = repo['full_name']
        assert any(r['full_name'] == full_name for r in request(alice, 'GET', GOLF + '/api/repositories')['repositories'])
        assert all(r['full_name'] != full_name for r in request(bob, 'GET', GOLF + '/api/repositories')['repositories'])
        request(client(), 'GET', GITEA + '/api/v1/repos/' + full_name, expected=404)
        with tempfile.TemporaryDirectory(prefix='golf-git-smoke-') as directory:
            path = Path(directory)
            command('git', 'init', '-b', 'main', cwd=path)
            (path / 'README.md').write_text('# Local Golf check\n')
            command('git', 'add', 'README.md', cwd=path)
            command('git', '-c', 'user.name=Golf Check', '-c', 'user.email=check@example.invalid',
                    'commit', '-m', 'Verify real Git transport', cwd=path)
            askpass = path / 'askpass.py'
            askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint(os.environ["GOLF_CHECK_USER"] if "Username" in sys.argv[1] else os.environ["GOLF_CHECK_TOKEN"])\n')
            askpass.chmod(0o700)
            env = {**os.environ, 'GIT_ASKPASS': str(askpass), 'GIT_TERMINAL_PROMPT': '0',
                   'GOLF_CHECK_USER': alice_name, 'GOLF_CHECK_TOKEN': alice_token}
            command('git', '-c', 'credential.helper=', 'push', GITEA + '/' + full_name + '.git', 'main', env=env, cwd=path)
            revision = command('git', 'rev-parse', 'HEAD', cwd=path)
            remote = command('git', '-c', 'credential.helper=', 'ls-remote', GITEA + '/' + full_name + '.git',
                             'refs/heads/main', env=env, cwd=path)
            assert remote.split()[0] == revision
        print('PASS: real sessions, private repository isolation, origin rejection and Git push')
        if args.restart:
            command('docker', 'compose', 'restart', 'golf', 'gitea')
            ready()
            assert any(r['full_name'] == full_name for r in request(alice, 'GET', GOLF + '/api/repositories')['repositories'])
            try:
                command('docker', 'compose', 'stop', 'gitea')
                request(client(), 'GET', GOLF + '/readyz', expected=503)
                request(alice, 'GET', GOLF + '/api/repositories', expected=502)
            finally:
                command('docker', 'compose', 'start', 'gitea')
                ready()
            print('PASS: persisted session/repository after restart; dependency outage fails visibly')
        basic = base64.b64encode(f'{alice_name}:{alice_password}'.encode()).decode()
        tokens_url = GITEA + '/api/v1/users/' + alice_name + '/tokens'
        tokens = request(client(), 'GET', tokens_url, headers={'Authorization': 'Basic ' + basic})
        token_id = next(t['id'] for t in tokens if t['name'] == 'golf-local-check')
        request(client(), 'DELETE', tokens_url + '/' + str(token_id), headers={'Authorization': 'Basic ' + basic}, expected=204)
        request(alice, 'GET', GOLF + '/api/session', expected=401)
        request(bob, 'DELETE', GOLF + '/api/session', expected=204)
        request(bob, 'GET', GOLF + '/api/repositories', expected=401)
        print('PASS: upstream token revocation and Golf logout')
    finally:
        for name in users:
            admin('delete', '--username', name, '--purge')
        print('Temporary Gitea users and repositories removed.')


if __name__ == '__main__':
    main()
