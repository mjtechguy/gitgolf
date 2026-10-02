#!/usr/bin/env python3
"""Real Gitea publication faults; experimental journal, not product enforcement.

Uses the pinned disposable provider fixture. Credentials stay in process memory
and environment. Does not modify normal Compose, provider tables or ref files.
"""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('protection_fixture', Path(__file__).with_name('gitea-protection-smoke.py'))
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def worker(request):
    """Small durable admission experiment, intentionally separate from Golf SQL."""
    with sqlite3.connect(request['journal']) as db:
        db.execute('BEGIN IMMEDIATE')
        epoch = db.execute('SELECT epoch FROM authority').fetchone()[0]
        identity = tuple(request[key] for key in ('base', 'candidate', 'epoch', 'repository', 'ref'))
        row = db.execute('SELECT base,candidate,epoch,repository,ref,state FROM intents WHERE id=?', (request['id'],)).fetchone()
        if row and row[:5] != identity:
            return {'state': 'rejected_identity'}
        if row and row[5] == 'committed':
            return {'state': 'committed', 'replayed': True}
        if request['epoch'] != epoch:
            return {'state': 'rejected_epoch'}
        # ponytail: harness-wide barrier; production needs durable resource-scoped
        # reservations plus target fencing, not this global serialization.
        if db.execute("SELECT 1 FROM intents WHERE state IN ('issued','uncertain')").fetchone():
            return {'state': 'blocked_uncertain'}
        db.execute('INSERT INTO intents VALUES (?,?,?,?,?,?,?)',
                   (request['id'], *identity, 'issued'))
        db.commit()
    remote = urlsplit(request['remote'])
    assert remote.scheme == 'http' and remote.hostname in ('localhost', '127.0.0.1')
    assert request['ref'] == 'refs/heads/main'
    command = ['git', 'push', '--quiet', '--force-with-lease=' + request['ref'] + ':' + request['base'],
               request['remote'], request['candidate'] + ':' + request['ref']]
    process = subprocess.Popen(command, cwd=request['work'], env=provider.git_env(request['actor']),
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    def drain():
        size = 0
        for line in iter(lambda: process.stderr.readline((2 << 20) + 1), b''):
            size += len(line)
            if size > 2 << 20:
                process.kill()
                break
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        status = process.wait(timeout=35)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
        status = -1
    reader.join(timeout=5)
    state = 'committed' if status == 0 else 'uncertain'
    with sqlite3.connect(request['journal']) as db:
        db.execute('UPDATE intents SET state=? WHERE id=?', (state, request['id']))
    return {'state': state, 'git_succeeded': status == 0}


def start_worker(request):
    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--worker'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=True)
    process.stdin.write(json.dumps(request))
    process.stdin.close()
    process.stdin = None
    return process


def finish_worker(process):
    out, _ = process.communicate(timeout=45)
    assert process.returncode == 0, 'Publisher experiment failed; private output withheld'
    return json.loads(out.splitlines()[-1])


def kill_worker(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=5)


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(30)
        return connection, address


class FaultProxy:
    """One bounded Git HTTP fault, not an authorization gateway."""
    def __init__(self, upstream, repository, mode):
        self.upstream = urlsplit(upstream)
        self.repository = repository
        self.mode = mode
        self.received = threading.Event()
        self.release = threading.Event()
        self.completed = threading.Event()
        self.posts = 0
        self.error = False
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def handle_git(self):
                if self.path not in (f'/{repository}.git/info/refs?service=git-receive-pack',
                                     f'/{repository}.git/git-receive-pack'):
                    self.send_error(404)
                    return
                connection = None
                try:
                    self.connection.settimeout(30)
                    length = int(self.headers.get('Content-Length', '0'))
                    assert 0 <= length <= 2 << 20 and not self.headers.get('Transfer-Encoding')
                    body = self.rfile.read(length)
                    is_write = self.command == 'POST'
                    if is_write:
                        fixture.posts += 1
                        assert fixture.posts == 1, 'Unexpected duplicate fixture write'
                        fixture.received.set()
                        if mode == 'delay':
                            assert fixture.release.wait(25), 'Fault gate timed out'
                    connection = http.client.HTTPConnection(fixture.upstream.hostname, fixture.upstream.port, timeout=20)
                    headers = {key: value for key, value in self.headers.items()
                               if key.lower() not in ('host', 'connection', 'transfer-encoding')}
                    headers['Host'] = fixture.upstream.netloc
                    headers['Connection'] = 'close'
                    connection.request(self.command, self.path, body, headers)
                    response = connection.getresponse()
                    data = response.read((2 << 20) + 1)
                    assert len(data) <= 2 << 20
                    if is_write:
                        fixture.completed.set()
                    if is_write and mode == 'drop':
                        self.close_connection = True
                        return
                    self.send_response(response.status)
                    for key in ('Content-Type', 'Content-Encoding'):
                        if response.getheader(key):
                            self.send_header(key, response.getheader(key))
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception:
                    fixture.error = True
                    self.close_connection = True
                finally:
                    if connection:
                        connection.close()
            do_GET = handle_git
            do_POST = handle_git
        self.server = BoundedHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.remote = f'http://127.0.0.1:{self.server.server_port}/{repository}.git'

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class HookGate:
    """One random, bounded rendezvous reached only by this fixture's Git hook."""
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.settled = threading.Event()
        route = '/gate/' + secrets.token_hex(32)
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                if self.path != route:
                    self.send_error(404)
                    return
                fixture.entered.set()
                released = fixture.release.wait(20)
                self.send_response(200 if released else 503)
                self.send_header('Content-Length', '0')
                self.end_headers()
                fixture.settled.set()
        # Docker Desktop reaches the host through host.docker.internal. This
        # short-lived port exposes only the unguessable, credential-free gate.
        self.server = BoundedHTTPServer(('0.0.0.0', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        url = 'http://host.docker.internal:' + str(self.server.server_port) + route
        self.hook = '#!/bin/sh\nwget -q -T 25 -O /dev/null ' + url + ' || exit 1\nexit 0\n'

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def qualify():
    p = provider
    prefix = 'golf-publisher-' + secrets.token_hex(5)
    organization = prefix + '-org'
    bootstrap = prefix + '-bootstrap'
    users, owned_repos, actors = [], [], {}
    admin_token = None
    org_created = False
    processes = []
    try:
        p.admin('create', '--username', bootstrap, '--email', bootstrap + '@example.invalid',
            '--random-password', '--random-password-length', '32', '--admin', '--must-change-password=false')
        users.append(bootstrap)
        admin_token = p.token_for(bootstrap, 'write:admin,write:user,write:organization,write:repository,write:issue')
        for role in ('owner', 'author', 'publisher', 'outsider'):
            name = prefix + '-' + role
            identity = p.api(admin_token, 'POST', 'admin/users', {'username': name,
                'email': name + '@example.invalid', 'password': secrets.token_urlsafe(32),
                'must_change_password': False, 'send_notify': False}, expected=201)
            assert not identity['is_admin']
            users.append(name)
            actors[role] = {'name': name, 'id': identity['id'], 'token': p.token_for(name)}
        owner, author, publisher = (actors[role] for role in ('owner', 'author', 'publisher'))
        p.api(owner['token'], 'POST', 'orgs', {'username': organization, 'visibility': 'private'}, expected=201)
        org_created = True
        repo = p.api(owner['token'], 'POST', f'orgs/{organization}/repos', {
            'name': 'canonical', 'private': True, 'auto_init': True, 'default_branch': 'main'}, expected=201)
        name = repo['full_name']
        owned_repos.append(name)
        route = 'repos/' + name
        p.api(owner['token'], 'PATCH', route, {'allow_manual_merge': True, 'autodetect_manual_merge': False})
        settings = p.api(owner['token'], 'GET', route)
        assert settings['allow_manual_merge'] and not settings['autodetect_manual_merge']
        remote = p.GITEA + '/' + name + '.git'
        team = p.api(owner['token'], 'POST', f'orgs/{organization}/teams', {
            'name': 'writers', 'permission': 'write',
            'units_map': {'repo.code': 'write', 'repo.pulls': 'write', 'repo.issues': 'read'}}, expected=201)
        for actor in (author, publisher):
            p.api(owner['token'], 'PUT', f'teams/{team["id"]}/members/{actor["name"]}', expected=204)
        p.api(owner['token'], 'PUT', f'teams/{team["id"]}/repos/{name}', expected=204)
        deadline = time.monotonic() + 30
        while p.api(owner['token'], 'GET', route)['empty']:
            assert time.monotonic() < deadline
            time.sleep(0.2)
        p.api(owner['token'], 'POST', route + '/branch_protections', {'rule_name': 'main',
            'enable_push': True, 'enable_push_whitelist': True,
            'push_whitelist_usernames': [publisher['name']], 'enable_force_push': False,
            'enable_merge_whitelist': True, 'merge_whitelist_usernames': [publisher['name']],
            'block_admin_merge_override': True}, expected=201)
        p.api(publisher['token'], 'PATCH', route + '/branch_protections/main', {'enable_push': False}, expected=403)
        with tempfile.TemporaryDirectory(prefix='golf-publisher-client-') as temporary:
            work = Path(temporary) / 'source'
            p.command('git', 'clone', '--quiet', remote, str(work), env=p.git_env(author))
            def git(*args, actor=publisher, success=True):
                return p.command('git', *args, cwd=work, env=p.git_env(actor), success=success)
            git('config', 'user.name', 'Golf publisher proof')
            git('config', 'user.email', 'publisher@example.invalid')
            git('config', 'commit.gpgsign', 'false')
            def current():
                return git('ls-remote', remote, 'refs/heads/main').split()[0]
            def candidate(base, label):
                git('checkout', '--quiet', '-B', label, base)
                (work / (label + '.txt')).write_text(label + '\n')
                git('add', '--', label + '.txt')
                git('commit', '--quiet', '-m', label)
                head = git('rev-parse', 'HEAD')
                git('push', '--quiet', remote, head + ':refs/heads/' + label, actor=author)
                git('checkout', '--quiet', '-B', 'integration', base)
                git('merge', '--quiet', '--no-ff', '-m', 'Candidate ' + label, head)
                result = git('rev-parse', 'HEAD')
                assert git('show', '-s', '--format=%P', result).split() == [base, head]
                return result
            journal = Path(temporary) / 'journal.sqlite'
            with sqlite3.connect(journal) as db:
                db.execute('CREATE TABLE authority(epoch INTEGER NOT NULL)')
                db.execute('INSERT INTO authority VALUES(1)')
                db.execute('CREATE TABLE intents(id TEXT PRIMARY KEY, base TEXT, candidate TEXT, epoch INTEGER, repository INTEGER, ref TEXT, state TEXT)')
            def request(identifier, base, commit, endpoint=remote, epoch=1):
                return {'journal': str(journal), 'id': identifier, 'base': base, 'candidate': commit,
                        'remote': endpoint, 'work': str(work), 'epoch': epoch, 'actor': publisher,
                        'repository': repo['id'], 'ref': 'refs/heads/main'}
            def run(data):
                process = start_worker(data)
                processes.append(process)
                return finish_worker(process)
            def reconcile(identifier, transport_settled):
                with sqlite3.connect(journal) as db:
                    db.execute('BEGIN IMMEDIATE')
                    entry = db.execute('SELECT base,candidate,state FROM intents WHERE id=?', (identifier,)).fetchone()
                    observed = current()
                    if not transport_settled or observed != entry[1]:
                        return 'uncertain'
                    db.execute("UPDATE intents SET state='committed' WHERE id=?", (identifier,))
                    return 'committed'
            # Actual provider commit succeeds; only its response is discarded.
            base = current()
            first = candidate(base, 'lost-response')
            for actor in (author, owner):
                git('push', '--quiet', remote, first + ':refs/heads/main', actor=actor, success=False)
            with FaultProxy(p.GITEA, name, 'drop') as fault:
                lost = request('lost', base, first, fault.remote)
                assert run(lost)['state'] == 'uncertain'
                assert fault.completed.is_set() and not fault.error and current() == first
                assert run(request('replacement', first, first))['state'] == 'blocked_uncertain'
                assert reconcile('lost', False) == 'uncertain'
                assert reconcile('lost', True) == 'committed'
                assert run(lost) == {'state': 'committed', 'replayed': True}
                for key, changed in (('base', first), ('candidate', base), ('epoch', 99),
                                     ('repository', repo['id'] + 1), ('ref', 'refs/heads/other')):
                    assert run(dict(lost, **{key: changed}))['state'] == 'rejected_identity'
                assert fault.posts == 1
            p.check('real provider committed exact candidate despite lost response; journal blocks replacement and reconciles without duplicate push')
            # A transport-accepted request can be forwarded after publisher death.
            second = candidate(first, 'delayed-request')
            third = candidate(first, 'replacement-candidate')
            with FaultProxy(p.GITEA, name, 'delay') as fault:
                delayed = request('delayed', first, second, fault.remote)
                process = start_worker(delayed)
                processes.append(process)
                assert fault.received.wait(15), 'Publisher did not reach delayed request gate'
                kill_worker(process)
                assert current() == first
                with sqlite3.connect(journal) as db:
                    db.execute('UPDATE authority SET epoch=2')
                replacement = request('new-owner', first, third, epoch=2)
                assert run(replacement)['state'] == 'blocked_uncertain'
                assert reconcile('delayed', False) == 'uncertain'
                assert fault.posts == 1
                fault.release.set()
                assert fault.completed.wait(20), 'Delayed request did not finish upstream'
                assert not fault.error and current() == second
                assert reconcile('delayed', True) == 'committed'
                assert run(request('stale-epoch', second, third))['state'] == 'rejected_epoch'
            p.check('issued transport survived publisher death/new epoch; replacement stays blocked until old write settles')
            # A supported hook makes an explicit rendezvous inside Gitea receive.
            held = candidate(second, 'provider-held')
            competing = candidate(second, 'provider-replacement')
            hook_route = route + '/hooks/git/pre-receive'
            p.api(admin_token, 'PATCH', 'admin/users/' + owner['name'], {'allow_git_hook': True})
            with HookGate() as gate:
                p.api(owner['token'], 'PATCH', hook_route, {'content': gate.hook})
                p.api(publisher['token'], 'PATCH', hook_route, {'content': gate.hook}, expected=403)
                process = start_worker(request('inside-provider', second, held, epoch=2))
                processes.append(process)
                try:
                    assert gate.entered.wait(15), 'Provider hook gate timed out'
                    assert current() == second
                    with sqlite3.connect(journal) as db:
                        db.execute('UPDATE authority SET epoch=3')
                    assert run(request('provider-replacement', second, competing, epoch=3))['state'] == 'blocked_uncertain'
                    gate.release.set()
                    assert finish_worker(process)['state'] == 'committed'
                    assert gate.settled.is_set() and current() == held
                    p.check('write paused inside provider completes under old authority; replacement remains blocked by issued intent')
                finally:
                    gate.release.set()
                    if process.poll() is None:
                        process.communicate(timeout=45)
                    for running in processes:
                        kill_worker(running)
                    p.api(owner['token'], 'DELETE', hook_route, expected=204)
            # Private-fork proof follows below; no native source mutation barrier is claimed.
            fork = p.api(author['token'], 'POST', route + '/forks', {'name': 'private-fork'}, expected=202)
            fork_name = fork['full_name']
            owned_repos.insert(0, fork_name)
            assert fork['private'] and fork['fork'] and fork['id'] != repo['id']
            fork_remote = p.GITEA + '/' + fork_name + '.git'
            p.api(actors['outsider']['token'], 'GET', 'repos/' + fork_name, expected=404)
            fork_code, _ = p.api(publisher['token'], 'GET', 'repos/' + fork_name, expected=None)
            assert fork_code in (200, 404), 'Unexpected private fork access result'
            git('fetch', '--quiet', remote, 'main')
            base = current()
            git('checkout', '--quiet', '-B', 'fork-change', base)
            (work / 'fork.txt').write_text('private fork change\n')
            git('add', '--', 'fork.txt')
            git('commit', '--quiet', '-m', 'Private fork change')
            head = git('rev-parse', 'HEAD')
            git('push', '--quiet', fork_remote, head + ':refs/heads/fork-change', actor=author)
            pull = p.api(author['token'], 'POST', route + '/pulls', {
                'head': author['name'] + ':fork-change', 'base': 'main', 'title': 'Private fork proof'}, expected=201)
            deadline = time.monotonic() + 30
            while True:
                detail = p.api(publisher['token'], 'GET', route + f'/pulls/{pull["number"]}')
                if detail['head']['sha'] == head and detail['head']['repo_id'] == fork['id']:
                    break
                assert time.monotonic() < deadline
                time.sleep(0.2)
            assert detail['head']['ref'] == 'fork-change'
            assert git('ls-remote', fork_remote, 'refs/heads/fork-change', actor=author).split()[0] == head
            if fork_code == 200:
                assert git('ls-remote', fork_remote, 'refs/heads/fork-change').split()[0] == head
            git('fetch', '--quiet', remote, f'refs/pull/{pull["number"]}/head')
            assert git('rev-parse', 'FETCH_HEAD') == head
            git('checkout', '--quiet', '-B', 'fork-integration', base)
            git('merge', '--quiet', '--no-ff', '-m', 'Private fork candidate', head)
            exact = git('rev-parse', 'HEAD')
            assert git('show', '-s', '--format=%P', exact).split() == [base, head]
            tree = git('rev-parse', exact + '^{tree}')
            assert run(request('fork-publication', base, exact, epoch=3))['state'] == 'committed'
            assert current() == exact
            assert not p.api(publisher['token'], 'GET', route + f'/pulls/{pull["number"]}')['merged']
            manual_code, _ = p.api(publisher['token'], 'POST', route + f'/pulls/{pull["number"]}/merge', {
                'do': 'manually-merged', 'merge_commit_id': exact}, expected=None)
            assert manual_code == 200, 'Explicit manual finalization status=' + str(manual_code)
            detail = p.api(publisher['token'], 'GET', route + f'/pulls/{pull["number"]}')
            assert detail['merged'] and detail['merge_commit_sha'] == exact
            git('fetch', '--quiet', remote, 'main')
            assert git('rev-parse', 'FETCH_HEAD^{tree}') == tree
            assert git('show', '-s', '--format=%P', 'FETCH_HEAD').split() == [base, head]
            p.check('private fork IDs/head and PR objects resolved by scoped publisher; exact candidate published and PR finalized')
            print('OBSERVED: publisher direct private-fork metadata status=' + str(fork_code), flush=True)
            # The private source remains an independent writer in the current profile.
            base = exact
            git('checkout', '--quiet', '-B', 'fork-race', base)
            (work / 'fork-race.txt').write_text('reviewed source\n')
            git('add', '--', 'fork-race.txt')
            git('commit', '--quiet', '-m', 'Fork source one')
            source = git('rev-parse', 'HEAD')
            git('push', '--quiet', fork_remote, source + ':refs/heads/fork-race', actor=author)
            race_pull = p.api(author['token'], 'POST', route + '/pulls', {
                'head': author['name'] + ':fork-race', 'base': 'main', 'title': 'Fork race proof'}, expected=201)
            git('checkout', '--quiet', '-B', 'fork-race-integration', base)
            git('merge', '--quiet', '--no-ff', '-m', 'Fork race candidate', source)
            stale_candidate = git('rev-parse', 'HEAD')
            with HookGate() as gate:
                p.api(owner['token'], 'PATCH', hook_route, {'content': gate.hook})
                process = start_worker(request('fork-race', base, stale_candidate, epoch=3))
                processes.append(process)
                try:
                    assert gate.entered.wait(15), 'Fork race provider hook gate timed out'
                    git('checkout', '--quiet', '-B', 'fork-race', source)
                    (work / 'fork-race.txt').write_text('unreviewed newer source\n')
                    git('add', '--', 'fork-race.txt')
                    git('commit', '--quiet', '-m', 'Fork source two')
                    newer_source = git('rev-parse', 'HEAD')
                    source_push = subprocess.Popen(['git', 'push', '--quiet', fork_remote,
                        newer_source + ':refs/heads/fork-race'], cwd=work, env=p.git_env(author),
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                    processes.append(source_push)
                    deadline = time.monotonic() + 10
                    while git('ls-remote', fork_remote, 'refs/heads/fork-race', actor=author).split()[0] != newer_source:
                        assert time.monotonic() < deadline, 'Fork source did not move during provider pause'
                        time.sleep(0.1)
                    assert not gate.settled.is_set(), 'Hook timed out before source readback'
                    assert current() == base, 'Fixture failed to move source within provider pause'
                    gate.release.set()
                    assert finish_worker(process)['state'] == 'committed'
                    source_push.communicate(timeout=30)
                    assert source_push.returncode == 0, 'Fork source push failed; private output withheld'
                    assert gate.settled.is_set() and current() == stale_candidate
                    detail = p.api(publisher['token'], 'GET', route + f'/pulls/{race_pull["number"]}')
                    assert detail['head']['repo_id'] == fork['id'] and detail['head']['sha'] == newer_source
                    assert git('show', '-s', '--format=%P', stale_candidate).split() == [base, source]
                    git('merge-base', '--is-ancestor', newer_source, stale_candidate, success=False)
                    p.check('unmediated private-fork source advances inside target receive interval; old-source exact candidate still publishes (unsafe profile characterization)')
                finally:
                    gate.release.set()
                    if process.poll() is None:
                        process.communicate(timeout=45)
                    for running in processes:
                        kill_worker(running)
                    p.api(owner['token'], 'DELETE', hook_route, expected=204)
            # A surviving PR snapshot after branch deletion is not a live source proof.
            deadline = time.monotonic() + 30
            while True:
                snapshot = git('ls-remote', remote, f'refs/pull/{race_pull["number"]}/head')
                if snapshot and snapshot.split()[0] == newer_source:
                    break
                assert time.monotonic() < deadline, 'PR snapshot failed to reach new fork head'
                time.sleep(0.2)
            git('push', '--quiet', '--delete', fork_remote, 'fork-race', actor=author)
            p.api(author['token'], 'GET', 'repos/' + fork_name + '/branches/fork-race', expected=404)
            deleted = p.api(publisher['token'], 'GET', route + f'/pulls/{race_pull["number"]}')
            assert deleted['head']['repo_id'] == fork['id'] and deleted['head']['sha'] == newer_source
            assert deleted['head']['ref'] == f'refs/pull/{race_pull["number"]}/head'
            assert not git('ls-remote', fork_remote, 'refs/heads/fork-race', actor=author)
            p.check('deleted fork source is absent while PR detail retains snapshot SHA; admission must reject missing live source')
        print('OBSERVED: harness admission is experimental; real route exclusivity/policy/fork-source fencing remain unqualified', flush=True)
    finally:
        for process in processes:
            kill_worker(process)
        failures = []
        if admin_token:
            for name in owned_repos:
                try:
                    p.api(admin_token, 'DELETE', 'repos/' + name, expected=(204, 404))
                except Exception:
                    failures.append('fixture repository cleanup failed')
            if org_created:
                try:
                    p.api(admin_token, 'DELETE', 'orgs/' + organization, expected=204)
                    p.api(None, 'GET', 'orgs/' + organization, expected=404)
                except Exception:
                    failures.append('fixture organization cleanup failed')
        for name in reversed(users):
            try:
                if name == bootstrap:
                    p.api(admin_token, 'PATCH', 'admin/users/' + name, {'active': False})
                p.admin('delete', '--username', name, '--purge')
                p.api(None, 'GET', 'users/' + name, expected=404)
            except Exception:
                failures.append('fixture user cleanup failed')
        if failures:
            raise RuntimeError('; '.join(failures))
        p.check('disposable users, private fork, canonical repository and organization removed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--port', type=int, default=3020)
    args = parser.parse_args()
    if args.worker:
        raw = sys.stdin.read(65537)
        assert len(raw) <= 65536
        print(json.dumps(worker(json.loads(raw))), flush=True)
        return
    if not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    provider.run_isolated(qualify, args.port, prefix='golf-publisher', custom_hooks=True)


if __name__ == '__main__':
    main()
