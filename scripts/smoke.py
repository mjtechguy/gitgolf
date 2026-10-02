#!/usr/bin/env python3
"""Exercise the local Compose stack; creates then purges isolated test users.

Run after docker compose up -d --build. --restart also restarts services and
briefly stops Gitea to verify persistence and outage reporting on this dev stack.
Credentials stay in process memory and are never printed. --cli PATH optionally
checks a built Golf CLI against the same private repository and immutable commit.
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
import urllib.parse
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
        if url.startswith(GOLF + '/api/'):
            assert response.headers.get('Cache-Control') == 'no-store', f'Missing no-store: {url}'
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


def provider(token, method, route, payload=None, expected=200):
    return request(client(), method, GITEA + '/api/v1/' + route, payload,
                   {'Authorization': 'token ' + token}, expected)


def wait_for_push(token, full_name):
    # Gitea's first-push hook processes repository initialization asynchronously.
    # Its branch-detail route can panic while repository metadata is still empty.
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if not provider(token, 'GET', 'repos/' + full_name)['empty']:
            return
        time.sleep(0.25)
    raise RuntimeError('Gitea did not finish initial push processing within 45 seconds')


def pages(session, url, field):
    """Require complete, advancing pagination rather than silently stopping early."""
    values, page = [], 1
    for _ in range(20):
        result = request(session, 'GET', url + ('&' if '?' in url else '?') + f'limit=1&page={page}')
        assert len(result[field]) <= 1
        values.extend(result[field])
        if 'next_page' not in result:
            return values
        assert result[field] and result['next_page'] == page + 1
        page += 1
    raise AssertionError('Fixture pagination did not terminate')


def content(session, base, ref, path=''):
    return request(session, 'GET', base + '/contents?' + urllib.parse.urlencode({'ref': ref, 'path': path}))


def commit(path, message):
    command('git', '-c', 'user.name=Golf Check', '-c', 'user.email=check@example.invalid',
            'commit', '-m', message, cwd=path)
    return command('git', 'rev-parse', 'HEAD', cwd=path)


def cli_check(binary, token, full_name, revision, nested_path, nested_text):
    # Stdin keeps the credential out of process arguments and shell history.
    env = {key: value for key, value in os.environ.items() if key != 'GOLF_GITEA_TOKEN'}
    env['GOLF_URL'] = GOLF
    args = [str(binary), '--token-stdin', 'repo', 'contents', full_name,
            '--ref', revision, '--path', nested_path]
    result = subprocess.run(args, input=token + '\n', cwd=ROOT, env=env, capture_output=True, text=True)
    assert result.returncode == 0, 'CLI failed (output withheld to protect credentials)'
    assert token not in result.stdout and token not in result.stderr
    envelope = json.loads(result.stdout)
    assert envelope['schema_version'] == 'golf.cli.v0'
    assert envelope['data']['commit_id'] == revision
    assert envelope['data']['file']['content'] == nested_text
    invalid = secrets.token_hex(20)
    result = subprocess.run(args, input=invalid + '\n', cwd=ROOT, env=env, capture_output=True, text=True)
    assert result.returncode != 0 and not result.stdout
    assert invalid not in result.stderr
    print('PASS: CLI private immutable source, JSON schema and invalid-token failure')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart', action='store_true', help='restart/stop local Compose services for recovery checks')
    parser.add_argument('--cli', type=Path, help='also verify a built Golf CLI binary (for example bin/golf)')
    args = parser.parse_args()
    cli = args.cli.resolve() if args.cli else None
    if cli and not cli.is_file():
        parser.error('--cli must name an existing binary; run make cli first')
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
                          '--scopes', 'write:user,write:repository,write:issue', '--raw')
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
        base = GOLF + '/api/repositories/' + full_name
        assert any(r['full_name'] == full_name for r in request(alice, 'GET', GOLF + '/api/repositories')['repositories'])
        assert all(r['full_name'] != full_name for r in request(bob, 'GET', GOLF + '/api/repositories')['repositories'])
        request(client(), 'GET', GITEA + '/api/v1/repos/' + full_name, expected=404)
        assert request(alice, 'GET', base)['repository']['empty'] is True
        assert request(alice, 'GET', base + '/branches')['branches'] == []
        assert request(alice, 'GET', base + '/commits')['commits'] == []
        empty = request(alice, 'GET', base + '/contents', expected=409)
        assert empty['error']['code'] == 'empty_repository'
        assert request(alice, 'GET', base + '/issues')['issues'] == []
        with tempfile.TemporaryDirectory(prefix='golf-git-smoke-') as directory:
            path = Path(directory)
            work = path / 'work'
            work.mkdir()
            command('git', 'init', '-b', 'main', cwd=work)
            initial_text = '# Local Golf check\n<script>plain source, never execute</script>\n'
            (work / 'README.md').write_text(initial_text)
            command('git', 'add', 'README.md', cwd=work)
            first_revision = commit(work, 'Verify real Git transport')
            nested_path = 'docs/naïve space/hello world.txt'
            nested_text = 'Hello, 世界. This is an immutable source fixture.\n'
            (work / nested_path).parent.mkdir(parents=True)
            (work / nested_path).write_text(nested_text, encoding='utf-8')
            (work / 'binary.bin').write_bytes(b'Golf\x00binary\xff\n')
            (work / 'preview-limit.txt').write_bytes(b'x' * (256 * 1024))
            (work / 'large.txt').write_bytes(b'x' * (256 * 1024 + 1))
            crowded = work / 'crowded'
            crowded.mkdir()
            for index in range(1001):
                (crowded / f'file-{index:04}.txt').write_text('bounded directory fixture\n')
            (work / 'pointer.lfs').write_text('version https://git-lfs.github.com/spec/v1\n'
                                             'oid sha256:' + 'a' * 64 + '\nsize 123456\n')
            (work / 'outside-link').symlink_to('../../outside-golf-smoke')
            (work / '.gitmodules').write_text('[submodule "vendor/sample"]\n'
                                              '\tpath = vendor/sample\n\turl = https://example.invalid/sample.git\n')
            command('git', 'add', '.', cwd=work)
            # A normal Git index gitlink fixture: no server storage access or submodule fetch.
            command('git', 'update-index', '--add', '--cacheinfo', '160000,' + first_revision + ',vendor/sample', cwd=work)
            revision = commit(work, 'Add source browser boundary fixtures')
            askpass = path / 'askpass.py'
            askpass.write_text('#!/usr/bin/env python3\nimport os,sys\nprint(os.environ["GOLF_CHECK_USER"] if "Username" in sys.argv[1] else os.environ["GOLF_CHECK_TOKEN"])\n')
            askpass.chmod(0o700)
            env = {**os.environ, 'GIT_ASKPASS': str(askpass), 'GIT_TERMINAL_PROMPT': '0',
                   'GOLF_CHECK_USER': alice_name, 'GOLF_CHECK_TOKEN': alice_token}
            remote_url = GITEA + '/' + full_name + '.git'
            command('git', '-c', 'credential.helper=', 'push', remote_url, 'main', env=env, cwd=work)
            remote = command('git', '-c', 'credential.helper=', 'ls-remote', GITEA + '/' + full_name + '.git',
                             'refs/heads/main', env=env, cwd=work)
            assert remote.split()[0] == revision
            wait_for_push(alice_token, full_name)
            detail = request(alice, 'GET', base)['repository']
            assert detail['empty'] is False and detail['private'] is True
            assert detail['clone_url'] and detail['ssh_url']
            snapshot = content(alice, base, 'main')
            assert snapshot['kind'] == 'directory' and snapshot['commit_id'] == revision
            entries = {entry['name']: entry for entry in snapshot['entries']}
            assert entries['docs']['type'] == 'dir' and entries['README.md']['type'] == 'file'
            assert content(alice, base, revision, nested_path)['file']['content'] == nested_text
            assert content(alice, base, revision, 'README.md')['file']['content'] == initial_text
            assert len(content(alice, base, revision, 'preview-limit.txt')['file']['content']) == 256 * 1024
            bounded = request(alice, 'GET', base + '/contents?' + urllib.parse.urlencode({'ref': revision, 'path': 'crowded'}), expected=502)
            assert bounded['error']['code'] == 'forge_response_too_large'
            for file_path, kind in [('binary.bin', 'file'), ('large.txt', 'file'), ('pointer.lfs', 'file'),
                                    ('outside-link', 'symlink'), ('vendor/sample', 'submodule')]:
                result = content(alice, base, revision, file_path)
                assert result['commit_id'] == revision and result['kind'] == kind
                assert result['file']['preview_reason'] and not result['file'].get('content')

            branch_name = 'feature/source-browser'
            command('git', 'checkout', '-b', branch_name, cwd=work)
            (work / 'feature.txt').write_text('Pull request fixture\n')
            command('git', 'add', 'feature.txt', cwd=work)
            feature_revision = commit(work, 'Add a pull request fixture')
            command('git', '-c', 'credential.helper=', 'push', remote_url, branch_name, env=env, cwd=work)
            command('git', 'checkout', 'main', cwd=work)
            branches = pages(alice, base + '/branches', 'branches')
            assert {b['name']: b['commit_id'] for b in branches} == {'main': revision, branch_name: feature_revision}
            assert content(alice, base, branch_name, 'feature.txt')['commit_id'] == feature_revision
            history = pages(alice, base + '/commits?ref=' + urllib.parse.quote(revision, safe=''), 'commits')
            assert [entry['sha'] for entry in history] == [revision, first_revision]
            assert all(entry['message'] and entry['author_name'] and entry['authored_at'] for entry in history)

            (work / 'README.md').write_text('A new branch head\n')
            command('git', 'add', 'README.md', cwd=work)
            latest_revision = commit(work, 'Move main after the browser snapshot')
            command('git', '-c', 'credential.helper=', 'push', remote_url, 'main', env=env, cwd=work)
            assert content(alice, base, 'main', 'README.md')['commit_id'] == latest_revision
            old_file = content(alice, base, snapshot['commit_id'], 'README.md')
            assert old_file['commit_id'] == revision and old_file['file']['content'] == initial_text
            assert content(alice, base, snapshot['commit_id'], nested_path)['file']['content'] == nested_text

            issues_route = 'repos/' + full_name + '/issues'
            issue_body = '<script>issue text, never execute</script>\nA reproducible fixture.'
            opened = provider(alice_token, 'POST', issues_route, {'title': 'Open fixture', 'body': issue_body}, 201)
            closed = provider(alice_token, 'POST', issues_route, {'title': 'Closed fixture'}, 201)
            provider(alice_token, 'PATCH', issues_route + '/' + str(closed['number']), {'state': 'closed'}, 201)
            other = provider(alice_token, 'POST', issues_route, {'title': 'Second open fixture'}, 201)
            pull = provider(alice_token, 'POST', 'repos/' + full_name + '/pulls',
                            {'title': 'Excluded pull request', 'base': 'main', 'head': branch_name}, 201)
            for state, expected_numbers in [('all', {opened['number'], closed['number'], other['number']}),
                                             ('open', {opened['number'], other['number']}), ('closed', {closed['number']})]:
                issues = pages(alice, base + '/issues?state=' + state, 'issues')
                assert len(issues) == len(expected_numbers) and {i['number'] for i in issues} == expected_numbers
            issue_path = '/issues/' + str(opened['number'])
            issue = request(alice, 'GET', base + issue_path)['issue']
            assert issue['body'] == issue_body and issue['user']['login'] == alice_name
            assert issue['state'] == 'open' and issue['html_url'] and issue['created_at'] and issue['updated_at']
            request(alice, 'GET', base + '/issues/' + str(pull['number']), expected=404)
            print('PASS: empty repositories, source boundaries, slash refs, immutable snapshots, pagination and issues excluding PRs')

            routes = ['', '/branches', '/commits', '/contents', '/contents?' + urllib.parse.urlencode({'ref': revision, 'path': nested_path}),
                      '/issues', issue_path]
            missing = request(alice, 'GET', GOLF + '/api/repositories/' + alice_name + '/missing-repository', expected=404)
            for route in routes:
                request(client(), 'GET', base + route, expected=401)
                denied = request(bob, 'GET', base + route, expected=404)
                assert denied == missing, 'Private denial differs from a missing resource'
            for query in ['page=0', 'limit=101']:
                request(alice, 'GET', base + '/branches?' + query, expected=400)
            request(alice, 'GET', base + '/issues?state=invalid', expected=400)
            request(alice, 'GET', base + '/contents?' + urllib.parse.urlencode({'path': '../README.md'}), expected=400)
            request(alice, 'GET', base + '/contents?' + urllib.parse.urlencode({'ref': 'missing-branch'}), expected=404)

            for label, scopes in [('identity', 'read:user'), ('code', 'read:user,read:repository'),
                                  ('reader', 'read:user,read:repository,read:issue')]:
                token = admin('generate-access-token', '--username', alice_name, '--token-name', 'golf-check-' + label,
                              '--scopes', scopes, '--raw')
                scoped = client()
                request(scoped, 'POST', GOLF + '/api/session', {'token': token})
                request(scoped, 'GET', base, expected=403 if label == 'identity' else 200)
                request(scoped, 'GET', base + '/contents', expected=403 if label == 'identity' else 200)
                request(scoped, 'GET', base + issue_path, expected=200 if label == 'reader' else 403)
                request(scoped, 'GET', base + '/issues', expected=200 if label == 'reader' else 403)
                request(scoped, 'POST', GOLF + '/api/repositories', {'name': 'scope-denied', 'private': True}, expected=403)
                request(scoped, 'DELETE', GOLF + '/api/session', expected=204)
                if label == 'reader' and cli:
                    cli_check(cli, token, full_name, revision, nested_path, nested_text)
            print('PASS: direct private-resource isolation, no-store responses, input validation and least-privilege scopes')
        print('PASS: real sessions, private repository isolation, origin rejection and Git push')
        if args.restart:
            command('docker', 'compose', 'restart', 'golf', 'gitea')
            ready()
            assert any(r['full_name'] == full_name for r in request(alice, 'GET', GOLF + '/api/repositories')['repositories'])
            assert content(alice, base, revision, nested_path)['file']['content'] == nested_text
            try:
                command('docker', 'compose', 'stop', 'gitea')
                request(client(), 'GET', GOLF + '/readyz', expected=503)
                request(alice, 'GET', GOLF + '/api/repositories', expected=502)
                request(alice, 'GET', base + '/contents', expected=502)
            finally:
                command('docker', 'compose', 'start', 'gitea')
                ready()
            print('PASS: persisted session/repository after restart; dependency outage fails visibly')
        basic = base64.b64encode(f'{alice_name}:{alice_password}'.encode()).decode()
        tokens_url = GITEA + '/api/v1/users/' + alice_name + '/tokens'
        tokens = request(client(), 'GET', tokens_url, headers={'Authorization': 'Basic ' + basic})
        token_id = next(t['id'] for t in tokens if t['name'] == 'golf-local-check')
        request(client(), 'DELETE', tokens_url + '/' + str(token_id), headers={'Authorization': 'Basic ' + basic}, expected=204)
        for route in routes:
            request(alice, 'GET', base + route, expected=401)
        request(alice, 'GET', GOLF + '/api/session', expected=401)
        request(bob, 'DELETE', GOLF + '/api/session', expected=204)
        request(bob, 'GET', GOLF + '/api/repositories', expected=401)
        print('PASS: upstream token revocation and Golf logout')
    finally:
        cleanup_errors = []
        for name in users:
            try:
                admin('delete', '--username', name, '--purge')
            except RuntimeError:
                cleanup_errors.append(name)
        if cleanup_errors:
            raise RuntimeError('Could not purge temporary users: ' + ', '.join(cleanup_errors))
        print('Temporary Gitea users and repositories removed.')


if __name__ == '__main__':
    main()
