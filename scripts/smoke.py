#!/usr/bin/env python3
"""Exercise the local Compose stack; creates then purges isolated test users.

Run after docker compose up -d --build. --restart also restarts services and
briefly stops Forgejo to verify persistence and outage reporting on this dev stack.
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
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
GOLF = os.environ.get('GOLF_SMOKE_URL', 'http://localhost:8080')
GITEA = os.environ.get('GOLF_SMOKE_FORGE_URL', 'http://localhost:3001')


def command(*args, env=None, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed (output withheld to protect credentials)')
    return result.stdout.strip()


def admin(*args):
    if container := os.environ.get('GOLF_SMOKE_FORGE_CONTAINER'):
        binary = os.environ.get('GOLF_SMOKE_FORGE_KIND', 'forgejo')
        if binary not in ('gitea', 'forgejo'): raise ValueError('unsupported fixture provider')
        config = '/var/lib/gitea/custom/conf/app.ini' if binary == 'forgejo' else '/etc/gitea/app.ini'
        return command('docker', 'exec', container, binary, '--config', config, 'admin', 'user', *args)
    return command('docker', 'compose', 'exec', '-T', 'forgejo', 'forgejo',
                   '--config', '/var/lib/gitea/custom/conf/app.ini', 'admin', 'user', *args)


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
        if url.startswith(GOLF + '/rpc/'):
            assert response.headers.get('Cache-Control') == 'no-store', f'Missing no-store: {url}'
        return json.loads(raw) if raw else None


def rpc(session, procedure, payload=None, expected=200, headers=None, code=None):
    """Call the Connect JSON protocol directly; return its unmodified wire shape."""
    result = request(session, 'POST', GOLF + '/rpc/golf.v1.' + procedure,
                     {} if payload is None else payload,
                     {'Connect-Protocol-Version': '1', **(headers or {})}, expected)
    if expected != 200:
        codes = {400: 'invalid_argument', 401: 'unauthenticated', 403: 'permission_denied',
                 404: 'not_found', 429: 'resource_exhausted', 503: 'unavailable'}
        assert result['code'] == (code or codes[expected]) and result['message'], f'Unexpected Connect error for {procedure}'
    return result


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
    # Forgejo's first-push hook processes repository initialization asynchronously.
    # Its branch-detail route can panic while repository metadata is still empty.
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if not provider(token, 'GET', 'repos/' + full_name)['empty']:
            return
        time.sleep(0.25)
    raise RuntimeError('Forgejo did not finish initial push processing within 45 seconds')


def pages(session, procedure, payload, field):
    """Require complete, advancing pagination rather than silently stopping early."""
    values, page = [], 1
    for _ in range(20):
        result = rpc(session, procedure, {**payload, 'page': {'limit': 1, 'page': page}})
        rows = result.get(field, [])
        assert len(rows) <= 1
        values.extend(rows)
        next_page = result.get('page', {}).get('nextPage', 0)
        if not next_page:
            return values
        assert rows and next_page == page + 1
        page += 1
    raise AssertionError('Fixture pagination did not terminate')


def content(session, repository, ref, path=''):
    return rpc(session, 'RepositoryService/GetContents', {'repository': repository, 'ref': ref, 'path': path})


def commit(path, message):
    command('git', '-c', 'user.name=Golf Check', '-c', 'user.email=check@example.invalid',
            'commit', '-m', message, cwd=path)
    return command('git', 'rev-parse', 'HEAD', cwd=path)


def cli_check(binary, token, full_name, revision, nested_path, nested_text):
    # Stdin keeps the credential out of process arguments and shell history.
    env = {key: value for key, value in os.environ.items() if key not in {'GOLF_FORGE_TOKEN', 'GOLF_GITEA_TOKEN', 'GOLF_API_TOKEN', 'GOLF_NATIVE_TOKEN'}}
    env['GOLF_URL'] = GOLF
    args = [str(binary), '--token-stdin', 'repo', 'contents', full_name,
            '--ref', revision, '--path', nested_path]
    result = subprocess.run(args, input=token + '\n', cwd=ROOT, env=env, capture_output=True, text=True)
    assert result.returncode == 0, 'CLI failed (output withheld to protect credentials)'
    assert token not in result.stdout and token not in result.stderr
    envelope = json.loads(result.stdout)
    assert envelope['schema_version'] == 'golf.cli.v1'
    assert envelope['data']['commitId'] == revision
    assert envelope['data']['file']['content'] == nested_text
    neutral = subprocess.run([str(binary), 'repo', 'contents', full_name, '--ref', revision, '--path', nested_path], env={**env, 'GOLF_FORGE_TOKEN': token}, capture_output=True, text=True, timeout=30)
    assert neutral.returncode == 0 and json.loads(neutral.stdout)['data']['file']['content'] == nested_text, 'Neutral forge token alias failed'
    assert token not in neutral.stdout + neutral.stderr
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
            identity = rpc(session, 'SessionService/LoginWithGiteaToken', {'token': token})['user']
            assert identity['login'] == name and isinstance(identity['id'], str) and identity['id'].isdigit()
            if label == 'alice':
                alice, alice_token, alice_password = session, token, password
                alice_name = name
            else:
                bob = session
        rpc(client(), 'RepositoryService/ListRepositories', expected=401)
        rpc(alice, 'RepositoryService/CreateRepository', {'name': 'rejected', 'private': True},
            headers={'Origin': 'https://invalid.example'}, expected=403)
        rpc(alice, 'RepositoryService/CreateRepository', {'name': 'missing-visibility'}, expected=400)
        repo = rpc(alice, 'RepositoryService/CreateRepository',
                   {'name': 'smoke-private', 'description': 'Temporary local verification', 'private': True})['repository']
        assert repo['private'] is True and isinstance(repo['id'], str) and repo['id'].isdigit()
        full_name = repo['fullName']
        repository = {'owner': alice_name, 'name': repo['name']}
        assert any(r['fullName'] == full_name for r in rpc(alice, 'RepositoryService/ListRepositories').get('repositories', []))
        assert all(r['fullName'] != full_name for r in rpc(bob, 'RepositoryService/ListRepositories').get('repositories', []))
        request(client(), 'GET', GITEA + '/api/v1/repos/' + full_name, expected=404)
        assert rpc(alice, 'RepositoryService/GetRepository', {'repository': repository})['repository']['empty'] is True
        assert rpc(alice, 'RepositoryService/ListBranches', {'repository': repository}).get('branches', []) == []
        assert rpc(alice, 'RepositoryService/ListCommits', {'repository': repository}).get('commits', []) == []
        rpc(alice, 'RepositoryService/GetContents', {'repository': repository}, expected=400, code='failed_precondition')
        assert rpc(alice, 'RepositoryService/ListIssues', {'repository': repository}).get('issues', []) == []
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
            (work / 'empty.txt').write_text('')
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
            detail = rpc(alice, 'RepositoryService/GetRepository', {'repository': repository})['repository']
            assert detail.get('empty', False) is False and detail['private'] is True
            assert detail['cloneUrl'] and detail['sshUrl']
            snapshot = content(alice, repository, 'main')
            assert snapshot['kind'] == 'SOURCE_ENTRY_TYPE_DIRECTORY' and snapshot['commitId'] == revision
            entries = {entry['name']: entry for entry in snapshot['entries']}
            assert entries['docs']['type'] == 'SOURCE_ENTRY_TYPE_DIRECTORY' and entries['README.md']['type'] == 'SOURCE_ENTRY_TYPE_FILE'
            assert content(alice, repository, revision, nested_path)['file']['content'] == nested_text
            assert content(alice, repository, revision, 'README.md')['file']['content'] == initial_text
            empty_file = content(alice, repository, revision, 'empty.txt')['file']
            assert empty_file['content'] == '' and empty_file['entry'].get('size', '0') == '0'
            limit_file = content(alice, repository, revision, 'preview-limit.txt')['file']
            assert len(limit_file['content']) == 256 * 1024 and limit_file['entry']['size'] == str(256 * 1024)
            rpc(alice, 'RepositoryService/GetContents', {'repository': repository, 'ref': revision, 'path': 'crowded'}, expected=429)
            for file_path, kind in [('binary.bin', 'FILE'), ('large.txt', 'FILE'), ('pointer.lfs', 'FILE'),
                                    ('outside-link', 'SYMLINK'), ('vendor/sample', 'SUBMODULE')]:
                result = content(alice, repository, revision, file_path)
                assert result['commitId'] == revision and result['kind'] == 'SOURCE_ENTRY_TYPE_' + kind
                assert result['file']['entry']['type'] == result['kind']
                assert result['file']['previewReason'] and 'content' not in result['file']

            branch_name = 'feature/source-browser'
            command('git', 'checkout', '-b', branch_name, cwd=work)
            (work / 'feature.txt').write_text('Pull request fixture\n')
            command('git', 'add', 'feature.txt', cwd=work)
            feature_revision = commit(work, 'Add a pull request fixture')
            command('git', '-c', 'credential.helper=', 'push', remote_url, branch_name, env=env, cwd=work)
            command('git', 'checkout', 'main', cwd=work)
            branches = pages(alice, 'RepositoryService/ListBranches', {'repository': repository}, 'branches')
            assert {b['name']: b['commitId'] for b in branches} == {'main': revision, branch_name: feature_revision}
            assert content(alice, repository, branch_name, 'feature.txt')['commitId'] == feature_revision
            history = pages(alice, 'RepositoryService/ListCommits', {'repository': repository, 'ref': revision}, 'commits')
            assert [entry['sha'] for entry in history] == [revision, first_revision]
            assert all(entry['message'] and entry['authorName'] and entry['authoredAt'] for entry in history)

            (work / 'README.md').write_text('A new branch head\n')
            command('git', 'add', 'README.md', cwd=work)
            latest_revision = commit(work, 'Move main after the browser snapshot')
            command('git', '-c', 'credential.helper=', 'push', remote_url, 'main', env=env, cwd=work)
            assert content(alice, repository, 'main', 'README.md')['commitId'] == latest_revision
            old_file = content(alice, repository, snapshot['commitId'], 'README.md')
            assert old_file['commitId'] == revision and old_file['file']['content'] == initial_text
            assert content(alice, repository, snapshot['commitId'], nested_path)['file']['content'] == nested_text

            issues_route = 'repos/' + full_name + '/issues'
            issue_body = '<script>issue text, never execute</script>\nA reproducible fixture.'
            opened = provider(alice_token, 'POST', issues_route, {'title': 'Open fixture', 'body': issue_body}, 201)
            closed = provider(alice_token, 'POST', issues_route, {'title': 'Closed fixture'}, 201)
            provider(alice_token, 'PATCH', issues_route + '/' + str(closed['number']), {'state': 'closed'}, 201)
            other = provider(alice_token, 'POST', issues_route, {'title': 'Second open fixture'}, 201)
            pull = provider(alice_token, 'POST', 'repos/' + full_name + '/pulls',
                            {'title': 'Excluded pull request', 'base': 'main', 'head': branch_name}, 201)
            for state, expected_numbers in [('ISSUE_STATE_ALL', {opened['number'], closed['number'], other['number']}),
                                             ('ISSUE_STATE_OPEN', {opened['number'], other['number']}), ('ISSUE_STATE_CLOSED', {closed['number']})]:
                issues = pages(alice, 'RepositoryService/ListIssues', {'repository': repository, 'state': state}, 'issues')
                assert len(issues) == len(expected_numbers) and {i['number'] for i in issues} == expected_numbers
            issue_request = {'repository': repository, 'number': opened['number']}
            issue = rpc(alice, 'RepositoryService/GetIssue', issue_request)['issue']
            assert issue['body'] == issue_body and issue['user']['login'] == alice_name
            assert isinstance(issue['id'], str) and issue['id'].isdigit()
            assert issue['state'] == 'ISSUE_STATE_OPEN' and issue['htmlUrl'] and issue['createdAt'] and issue['updatedAt']
            rpc(alice, 'RepositoryService/GetIssue', {'repository': repository, 'number': pull['number']}, expected=404)
            print('PASS: empty repositories, source boundaries, slash refs, immutable snapshots, pagination and issues excluding PRs')

            calls = [('RepositoryService/GetRepository', {'repository': repository}),
                     ('RepositoryService/ListBranches', {'repository': repository}),
                     ('RepositoryService/ListCommits', {'repository': repository}),
                     ('RepositoryService/GetContents', {'repository': repository}),
                     ('RepositoryService/GetContents', {'repository': repository, 'ref': revision, 'path': nested_path}),
                     ('RepositoryService/ListIssues', {'repository': repository}),
                     ('RepositoryService/GetIssue', issue_request)]
            missing = rpc(alice, 'RepositoryService/GetRepository',
                          {'repository': {'owner': alice_name, 'name': 'missing-repository'}}, expected=404)
            for procedure, payload in calls:
                rpc(client(), procedure, payload, expected=401)
                denied = rpc(bob, procedure, payload, expected=404)
                assert denied == missing, 'Private denial differs from a missing resource'
            for page in [{'page': 10001}, {'limit': 101}]:
                rpc(alice, 'RepositoryService/ListBranches', {'repository': repository, 'page': page}, expected=400)
            defaults = rpc(alice, 'RepositoryService/ListBranches', {'repository': repository, 'page': {'page': 0, 'limit': 0}})
            assert {b['name'] for b in defaults.get('branches', [])} == {'main', branch_name}
            rpc(alice, 'RepositoryService/ListIssues', {'repository': repository, 'state': 999}, expected=400)
            rpc(alice, 'RepositoryService/GetContents', {'repository': repository, 'path': '../README.md'}, expected=400)
            rpc(alice, 'RepositoryService/GetContents', {'repository': repository, 'ref': 'missing-branch'}, expected=404)

            for label, scopes in [('identity', 'read:user'), ('code', 'read:user,read:repository'),
                                  ('reader', 'read:user,read:repository,read:issue')]:
                token = admin('generate-access-token', '--username', alice_name, '--token-name', 'golf-check-' + label,
                              '--scopes', scopes, '--raw')
                scoped = client()
                rpc(scoped, 'SessionService/LoginWithGiteaToken', {'token': token})
                rpc(scoped, 'RepositoryService/GetRepository', {'repository': repository}, expected=403 if label == 'identity' else 200)
                rpc(scoped, 'RepositoryService/GetContents', {'repository': repository}, expected=403 if label == 'identity' else 200)
                rpc(scoped, 'RepositoryService/GetIssue', issue_request, expected=200 if label == 'reader' else 403)
                rpc(scoped, 'RepositoryService/ListIssues', {'repository': repository}, expected=200 if label == 'reader' else 403)
                rpc(scoped, 'RepositoryService/CreateRepository', {'name': 'scope-denied', 'private': True}, expected=403)
                assert rpc(scoped, 'SessionService/Logout') == {}
                if label == 'reader' and cli:
                    cli_check(cli, token, full_name, revision, nested_path, nested_text)
            print('PASS: direct private-resource isolation, no-store responses, input validation and least-privilege scopes')
        print('PASS: real sessions, private repository isolation, origin rejection and Git push')
        if args.restart:
            command('docker', 'compose', 'restart', 'golf', 'forgejo')
            ready()
            assert any(r['fullName'] == full_name for r in rpc(alice, 'RepositoryService/ListRepositories').get('repositories', []))
            assert content(alice, repository, revision, nested_path)['file']['content'] == nested_text
            try:
                command('docker', 'compose', 'stop', 'forgejo')
                request(client(), 'GET', GOLF + '/readyz', expected=503)
                rpc(alice, 'RepositoryService/ListRepositories', expected=503)
                rpc(alice, 'RepositoryService/GetContents', {'repository': repository}, expected=503)
            finally:
                command('docker', 'compose', 'start', 'forgejo')
                ready()
            print('PASS: persisted session/repository after restart; dependency outage fails visibly')
        basic = base64.b64encode(f'{alice_name}:{alice_password}'.encode()).decode()
        tokens_url = GITEA + '/api/v1/users/' + alice_name + '/tokens'
        tokens = request(client(), 'GET', tokens_url, headers={'Authorization': 'Basic ' + basic})
        token_id = next(t['id'] for t in tokens if t['name'] == 'golf-local-check')
        request(client(), 'DELETE', tokens_url + '/' + str(token_id), headers={'Authorization': 'Basic ' + basic}, expected=204)
        for procedure, payload in calls:
            rpc(alice, procedure, payload, expected=401)
        rpc(alice, 'SessionService/GetSession', expected=401)
        assert rpc(bob, 'SessionService/Logout') == {}
        rpc(bob, 'RepositoryService/ListRepositories', expected=401)
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
        print('Temporary Forgejo users and repositories removed.')


if __name__ == '__main__':
    main()
