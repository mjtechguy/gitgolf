#!/usr/bin/env python3
"""Characterize Gitea 1.27.3 protected writes in a disposable PostgreSQL/Gitea instance.

Creates only randomly prefixed disposable users/org/repositories through supported
CLI/API and Git, then purges them. Does not modify Golf, existing accounts, site
configuration, Gitea database tables or repository files directly. User credentials
stay in memory/environment; provider passwords use a temporary 0600 environment
file. No passwords/tokens in command arguments/output. Successful completion
records observed limitations too; it does not close Golf's protected-write gate.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import threading
import base64
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
GITEA = ''
COMPOSE = []
MAX_RESPONSE = 2 << 20
SCOPES = 'write:user,write:organization,write:repository,write:issue'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def command(*args, env=None, cwd=ROOT, success=True):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=45)
    if (result.returncode == 0) != success:
        raise AssertionError(f'{args[0]} exit status {result.returncode}; output withheld')
    return result.stdout.strip()


def admin(*args):
    return command(*COMPOSE, 'exec', '-T', 'gitea', 'gitea',
                   '--config', '/etc/gitea/app.ini', 'admin', 'user', *args)


def api(token, method, route, payload=None, expected=200):
    headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'token ' + token
    request = urllib.request.Request(GITEA + '/api/v1/' + route, method=method,
        data=None if payload is None else json.dumps(payload).encode(), headers=headers)
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(MAX_RESPONSE + 1)
        assert len(raw) <= MAX_RESPONSE, 'Provider response exceeded bound'
        parsed = json.loads(raw) if raw else None
        if expected is None:
            return response.status, parsed
        expected = (expected,) if isinstance(expected, int) else expected
        reasons = ('Not all required status checks successful', 'Does not have enough approvals',
                   'The head branch is behind the base branch', 'User not allowed to merge PR',
                   'Please try again later', 'head out of date', 'merge push out of date')
        reason = next((item for item in reasons if item.encode() in raw), 'details withheld')
        assert response.status in expected, f'{method} {route}: {response.status}, expected {expected}; {reason}'
        return parsed


def token_for(name, scopes=SCOPES):
    value = admin('generate-access-token', '--username', name, '--token-name',
                  'golf-protection-proof-' + secrets.token_hex(4), '--scopes', scopes, '--raw')
    assert value and '\n' not in value, 'Token generator returned an invalid credential'
    return value


def git_env(user):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'GOLF_'))}
    env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_COUNT': '3',
                'GIT_CONFIG_KEY_0': 'http.extraHeader',
                'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + base64.b64encode((user['name'] + ':' + user['token']).encode()).decode(),
                'GIT_CONFIG_KEY_1': 'credential.helper', 'GIT_CONFIG_VALUE_1': '',
                'GIT_CONFIG_KEY_2': 'http.followRedirects', 'GIT_CONFIG_VALUE_2': 'false',
                'GIT_TERMINAL_PROMPT': '0'})
    return env


def check(label):
    print('PASS: ' + label, flush=True)


def qualify(protected_receive_check=None, review_observation_check=None):
    assert api(None, 'GET', 'version')['version'] == '1.27.3'
    with urllib.request.build_opener(NoRedirect()).open(GITEA + '/swagger.v1.json', timeout=15) as response:
        raw = response.read(MAX_RESPONSE + 1)
        assert len(raw) <= MAX_RESPONSE
    fields = json.loads(raw)['definitions']['MergePullRequestOption']['properties']
    assert set(fields) == {'do', 'head_commit_id', 'merge_commit_id', 'force_merge',
                          'merge_when_checks_succeed', 'delete_branch_after_merge',
                          'merge_message_field', 'merge_title_field'}, 'Merge API schema changed; requalify conditions'
    check('live pinned merge schema has expected head and no expected-base precondition')
    prefix = 'golf-protection-' + secrets.token_hex(5)
    bootstrap = prefix + '-bootstrap'
    organization = prefix + '-org'
    users = []
    bootstrap_token = None
    org_created = False
    records = {}
    try:
        admin('create', '--username', bootstrap, '--email', bootstrap + '@example.invalid',
              '--random-password', '--random-password-length', '32', '--admin', '--must-change-password=false')
        users.append(bootstrap)
        bootstrap_token = token_for(bootstrap, 'write:admin,write:user,write:organization,write:repository,write:issue')
        for role in ('owner', 'developer', 'reviewer', 'merger'):
            name = prefix + '-' + role
            actor = api(bootstrap_token, 'POST', 'admin/users', {
                'username': name, 'email': name + '@example.invalid', 'password': secrets.token_urlsafe(32),
                'must_change_password': False, 'send_notify': False}, expected=201)
            assert not actor['is_admin'], 'Protection actor must not be a site administrator'
            users.append(name)
            records[role] = {'name': name, 'token': token_for(name), 'id': actor['id']}
        owner, developer, reviewer = (records[role] for role in ('owner', 'developer', 'reviewer'))
        api(owner['token'], 'POST', 'orgs', {'username': organization, 'visibility': 'private'}, expected=201)
        org_created = True
        repository = api(owner['token'], 'POST', f'orgs/{organization}/repos', {
            'name': 'protected-core', 'private': True, 'auto_init': True, 'default_branch': 'main'}, expected=201)
        route = 'repos/' + repository['full_name']
        remote = GITEA + '/' + repository['full_name'] + '.git'
        team = api(owner['token'], 'POST', f'orgs/{organization}/teams', {
            'name': 'writers', 'permission': 'write', 'units_map': {
                'repo.code': 'write', 'repo.pulls': 'write', 'repo.issues': 'write'}}, expected=201)
        for actor in (developer, reviewer, records['merger']):
            api(owner['token'], 'PUT', f'teams/{team["id"]}/members/{actor["name"]}', expected=204)
        api(owner['token'], 'PUT', f'teams/{team["id"]}/repos/{repository["full_name"]}', expected=204)
        deadline = time.monotonic() + 30
        while api(owner['token'], 'GET', route)['empty']:
            assert time.monotonic() < deadline, 'Repository initialization timed out'
            time.sleep(0.2)
        with tempfile.TemporaryDirectory(prefix='golf-protection-git-') as temporary:
            work = Path(temporary) / 'source'
            command('git', 'clone', '--quiet', remote, str(work), env=git_env(developer))
            def git(*args, actor=developer, success=True):
                return command('git', *args, cwd=work, env=git_env(actor), success=success)
            git('config', 'user.name', 'Golf protection proof')
            git('config', 'user.email', 'protection@example.invalid')
            git('config', 'commit.gpgsign', 'false')
            def current():
                return git('ls-remote', remote, 'refs/heads/main').split()[0]
            def commit(branch, base, name):
                git('checkout', '--quiet', '-B', branch, base)
                (work / name).write_text(name + '\n' + secrets.token_hex(4) + '\n')
                git('add', '--', name)
                git('commit', '--quiet', '-m', 'Disposable protection fixture ' + name)
                return git('rev-parse', 'HEAD')
            def pull(branch, actor=developer):
                return api(actor['token'], 'POST', route + '/pulls', {
                    'title': 'Qualify ' + branch, 'head': branch, 'base': 'main'}, expected=201)
            def ready(number, head):
                deadline = time.monotonic() + 30
                while True:
                    item = api(developer['token'], 'GET', route + f'/pulls/{number}')
                    if item['head']['sha'] == head and item.get('mergeable'):
                        return item
                    assert time.monotonic() < deadline, 'Pull request mergeability did not settle'
                    time.sleep(0.2)
            def status(head, actor=developer):
                return api(actor['token'], 'POST', route + '/statuses/' + head, {
                    'state': 'success', 'context': 'golf/test', 'description': 'Fixture assertion, not actual CI'}, expected=201)
            def approve(number, head, actor=reviewer):
                return api(actor['token'], 'POST', route + f'/pulls/{number}/reviews', {
                    'event': 'APPROVED', 'commit_id': head, 'body': 'Disposable approval'}, expected=200)
            def merge(number, head, actor=developer, expected=200, force=False):
                expected = (expected,) if isinstance(expected, int) else expected
                deadline = time.monotonic() + 30
                while True:
                    code, body = api(actor['token'], 'POST', route + f'/pulls/{number}/merge', {
                        'do': 'merge', 'head_commit_id': head, 'force_merge': force}, expected=None)
                    reason = body.get('message', '') if isinstance(body, dict) else ''
                    if code == 405 and reason == 'Please try again later':
                        assert time.monotonic() < deadline, 'Provider conflict check did not settle'
                        assert not api(actor['token'], 'GET', route + f'/pulls/{number}')['merged']
                        time.sleep(0.2)
                        continue
                    safe_reason = next((item for item in ('status checks', 'enough approvals', 'behind the base', 'head out of date', 'push out of date', 'not allowed') if item in reason), 'details withheld')
                    assert code in expected, f'Merge {number}: {code}, expected {expected}; {safe_reason}'
                    return code
            protection = route + '/branch_protections/main'
            base = current()
            rule = api(owner['token'], 'POST', route + '/branch_protections', {
                'rule_name': 'main', 'enable_push': False, 'enable_force_push': False,
                'required_approvals': 1, 'dismiss_stale_approvals': True,
                'enable_status_check': True, 'status_check_contexts': ['golf/test'],
                'block_on_outdated_branch': True, 'block_admin_merge_override': True}, expected=201)
            assert rule['block_admin_merge_override'] and not rule['enable_push']
            assert rule['required_approvals'] == 1 and rule['dismiss_stale_approvals']
            assert rule['enable_status_check'] and rule['status_check_contexts'] == ['golf/test']
            first = commit('feature', base, 'feature-one.txt')
            git('push', '--quiet', remote, 'HEAD:refs/heads/feature')
            for actor in (developer, owner):
                git('push', '--quiet', remote, 'HEAD:refs/heads/main', actor=actor, success=False)
                api(actor['token'], 'POST', route + '/contents/forbidden.txt', {
                    'branch': 'main', 'content': base64.b64encode(b'forbidden').decode(), 'message': 'Must deny'}, expected=403)
            api(developer['token'], 'PATCH', protection, {'enable_push': True}, expected=403)
            api(developer['token'], 'DELETE', protection, expected=403)
            assert current() == base
            check('owner/developer direct Git and content API writes denied; developer cannot weaken protection')
            if protected_receive_check:
                protected_receive_check((developer, owner), repository, work, first, base)
            request = pull('feature')
            number = request['number']
            ready(number, first)
            merge(number, first, expected=405)
            merge(number, first, actor=owner, expected=405, force=True)
            approve(number, first)
            merge(number, first, expected=405)
            written = status(first)
            assert written['creator']['id'] == developer['id']
            second = commit('feature', first, 'feature-two.txt')
            git('push', '--quiet', remote, 'HEAD:refs/heads/feature')
            ready(number, second)
            status(second)
            if review_observation_check:
                review_observation_check(developer, repository, number, second, first)
            deadline = time.monotonic() + 30
            while True:
                reviews = api(reviewer['token'], 'GET', route + f'/pulls/{number}/reviews?limit=50')
                if any(item.get('dismissed') for item in reviews):
                    break
                if time.monotonic() >= deadline:
                    print('REVIEW_METADATA: ' + json.dumps([{key: item.get(key) for key in ('commit_id', 'state', 'dismissed', 'stale', 'official')} for item in reviews]), flush=True)
                    raise AssertionError('Changed head did not dismiss prior approval within deadline')
                time.sleep(0.2)
            merge(number, second, expected=405)
            updated_review = approve(number, second)
            assert updated_review['state'] == 'APPROVED' and not updated_review['dismissed']
            ready(number, second)
            merge(number, first, expected=409)
            assert current() == base
            check('missing checks/reviews and stale approval deny merge; expected old head rejected409 without base change')
            # Another valid PR advances the base after Golf would have inspected it.
            other_head = commit('intervening', base, 'intervening.txt')
            git('push', '--quiet', remote, 'HEAD:refs/heads/intervening')
            other = pull('intervening')
            ready(other['number'], other_head)
            approve(other['number'], other_head)
            status(other_head)
            merge(other['number'], other_head)
            advanced_base = current()
            assert advanced_base != base
            deadline = time.monotonic() + 30
            while True:
                view = api(developer['token'], 'GET', route + f'/pulls/{number}')
                if view['base']['sha'] == advanced_base:
                    break
                assert time.monotonic() < deadline, 'Base metadata did not advance'
                time.sleep(0.2)
            merge(number, second, expected=405)
            assert current() == advanced_base
            # This ordinary documented setting allows merging an outdated branch.
            api(owner['token'], 'PATCH', protection, {'block_on_outdated_branch': False})
            ready(number, second)
            merge(number, second)
            merged = current()
            git('fetch', '--quiet', remote, 'main')
            parents = git('show', '-s', '--format=%P', merged).split()
            assert parents == [advanced_base, second], 'Merge did not use the actual intervening base/head'
            check('outdated guard denies advanced base; head-only API then merges against new base with guard disabled')
            check('ordinary code writer can author accepted required status context; no trusted-producer guarantee')
            # Directly exercise two clients racing different PRs from one observed base.
            pending = []
            for index in range(2):
                branch = 'race-' + str(index)
                head = commit(branch, merged, branch + '.txt')
                git('push', '--quiet', remote, 'HEAD:refs/heads/' + branch)
                item = pull(branch)
                ready(item['number'], head)
                approve(item['number'], head)
                status(head)
                pending.append((item['number'], head))
            gate = threading.Barrier(2)
            def race(item):
                gate.wait(timeout=10)
                merge(item[0], item[1], expected=(200, 409))
                return api(developer['token'], 'GET', route + f'/pulls/{item[0]}')['merged']
            with ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(race, pending))
            assert any(outcomes), 'Concurrent merge attempts made no progress'
            git('fetch', '--quiet', remote, 'main')
            race_base = current()
            for (_, head), succeeded in zip(pending, outcomes):
                if succeeded:
                    git('merge-base', '--is-ancestor', head, race_base)
            check('concurrent head-qualified merges preserve successful heads; merged=' + str(outcomes))
            # Admin override is a configurable trust boundary, not always disabled.
            override_head = commit('override', race_base, 'override.txt')
            git('push', '--quiet', remote, 'HEAD:refs/heads/override')
            override = pull('override')
            ready(override['number'], override_head)
            merge(override['number'], override_head, actor=owner, expected=405, force=True)
            api(owner['token'], 'PATCH', protection, {'block_admin_merge_override': False})
            merge(override['number'], override_head, actor=owner, force=True)
            check('owner force-merge denied under strict rule and allowed after explicit policy relaxation')
            # Distinguish disabled force pushes from disabling all ordinary pushes.
            git('push', '--quiet', remote, base + ':refs/heads/release')
            api(owner['token'], 'POST', route + '/branch_protections', {
                'rule_name': 'release', 'enable_push': True, 'enable_force_push': False}, expected=201)
            git('push', '--quiet', remote, first + ':refs/heads/release')
            git('push', '--quiet', '--force', remote, base + ':refs/heads/release', success=False)
            assert git('ls-remote', remote, 'refs/heads/release').split()[0] == first
            check('enabled ordinary push accepts fast-forward; disabled force push rejects rewind')
            # A bounded observational race: do not wait for asynchronous review
            # invalidation. An allowed merge is a blocker, not a protection pass.
            api(owner['token'], 'PATCH', protection, {'block_admin_merge_override': True})
            accepted_stale = 0
            for trial in range(3):
                git('fetch', '--quiet', remote, 'main')
                old_base = current()
                branch = 'approval-window-' + str(trial)
                old_head = commit(branch, old_base, branch + '-one.txt')
                git('push', '--quiet', remote, 'HEAD:refs/heads/' + branch)
                item = pull(branch)
                ready(item['number'], old_head)
                approve(item['number'], old_head)
                status(old_head)
                new_head = commit(branch, old_head, branch + '-two.txt')
                git('push', '--quiet', remote, 'HEAD:refs/heads/' + branch)
                status(new_head)
                code, body = api(developer['token'], 'POST', route + f'/pulls/{item["number"]}/merge', {
                    'do': 'merge', 'head_commit_id': new_head}, expected=None)
                assert code in (200, 405, 409), f'Unexpected rapid-push merge response {code}'
                view = api(developer['token'], 'GET', route + f'/pulls/{item["number"]}')
                if code == 200:
                    assert view['merged'], 'Merge success lacked persisted result'
                    reviews = api(reviewer['token'], 'GET', route + f'/pulls/{item["number"]}/reviews?limit=50')
                    assert reviews and all(review['commit_id'] == old_head for review in reviews)
                    git('fetch', '--quiet', remote, 'main')
                    assert git('show', '-s', '--format=%P', current()).split() == [old_base, new_head]
                    accepted_stale += 1
                else:
                    assert not view['merged'] and current() == old_base
            print('OBSERVED: rapid changed-head merges accepted with only old approval: '
                  + str(accepted_stale) + '/3; timing sample, not a race-freedom proof', flush=True)
            # Scheduled auto-merge is an evolving PR intent, not an immutable
            # head-qualified request: its initial head argument is not retained.
            git('fetch', '--quiet', remote, 'main')
            auto_base = current()
            old_auto_head = commit('auto', auto_base, 'auto-one.txt')
            git('push', '--quiet', remote, 'HEAD:refs/heads/auto')
            auto_pull = pull('auto')
            ready(auto_pull['number'], old_auto_head)
            approve(auto_pull['number'], old_auto_head)
            api(developer['token'], 'POST', route + f'/pulls/{auto_pull["number"]}/merge', {
                'do': 'merge', 'head_commit_id': old_auto_head, 'merge_when_checks_succeed': True}, expected=201)
            new_auto_head = commit('auto', old_auto_head, 'auto-two.txt')
            git('push', '--quiet', remote, 'HEAD:refs/heads/auto')
            ready(auto_pull['number'], new_auto_head)
            deadline = time.monotonic() + 30
            while True:
                reviews = api(reviewer['token'], 'GET', route + f'/pulls/{auto_pull["number"]}/reviews?limit=50')
                if any(review['dismissed'] for review in reviews):
                    break
                assert time.monotonic() < deadline, 'Auto-merge stale approval did not settle'
                time.sleep(0.2)
            approve(auto_pull['number'], new_auto_head)
            status(new_auto_head)
            deadline = time.monotonic() + 45
            while True:
                view = api(developer['token'], 'GET', route + f'/pulls/{auto_pull["number"]}')
                if view['merged']:
                    break
                assert time.monotonic() < deadline, 'Qualified auto-merge did not complete'
                time.sleep(0.2)
            git('fetch', '--quiet', remote, 'main')
            assert git('show', '-s', '--format=%P', current()).split() == [auto_base, new_auto_head]
            check('scheduled auto-merge accepts later approved head; initial head argument is not an immutable condition')
            # A non-admin actor can be the only merge allowlisted writer. This
            # qualifies the primitive, not Golf's distributed lock/fencing policy.
            merger = records['merger']
            api(owner['token'], 'PATCH', protection, {
                'block_admin_merge_override': True, 'enable_merge_whitelist': True,
                'merge_whitelist_usernames': [merger['name']]})
            git('fetch', '--quiet', remote, 'main')
            service_base = current()
            service_head = commit('exclusive', service_base, 'exclusive.txt')
            git('push', '--quiet', remote, 'HEAD:refs/heads/exclusive')
            service_pull = pull('exclusive')
            ready(service_pull['number'], service_head)
            approve(service_pull['number'], service_head)
            status(service_head)
            for actor in (developer, reviewer, owner):
                merge(service_pull['number'], service_head, actor=actor, expected=405)
                api(actor['token'], 'POST', route + f'/pulls/{service_pull["number"]}/merge', {
                    'do': 'merge', 'head_commit_id': service_head,
                    'merge_when_checks_succeed': True}, expected=405)
            git('push', '--quiet', remote, service_head + ':refs/heads/main', actor=merger, success=False)
            api(merger['token'], 'PATCH', protection, {'enable_push': True}, expected=403)
            merge(service_pull['number'], service_head, actor=merger)
            check('exclusive non-admin merge allowlist works; ordinary merge/direct push/policy mutation denied')
            # Supported Git transport can condition an exact candidate on the
            # expected base, but it does not assert the source branch's head.
            api(owner['token'], 'PATCH', protection, {
                'enable_push': True, 'enable_push_whitelist': True,
                'push_whitelist_usernames': [merger['name']], 'enable_force_push': False})
            git('fetch', '--quiet', remote, 'main')
            lease_base = current()
            lease_head = commit('lease-source', lease_base, 'lease-source.txt')
            git('push', '--quiet', remote, 'HEAD:refs/heads/lease-source')
            git('checkout', '--quiet', '-B', 'candidate', lease_base)
            git('merge', '--quiet', '--no-ff', '-m', 'Exact candidate one', lease_head)
            candidate = git('rev-parse', 'HEAD')
            for actor in (developer, owner):
                git('push', '--quiet', remote, candidate + ':refs/heads/main', actor=actor, success=False)
            competing = commit('competing-base', lease_base, 'competing-base.txt')
            git('push', '--quiet', remote, competing + ':refs/heads/main', actor=merger)
            git('push', '--quiet', '--force-with-lease=refs/heads/main:' + lease_base,
                remote, candidate + ':refs/heads/main', actor=merger, success=False)
            assert current() == competing
            git('checkout', '--quiet', '-B', 'candidate', competing)
            git('merge', '--quiet', '--no-ff', '-m', 'Exact candidate two', lease_head)
            replacement = git('rev-parse', 'HEAD')
            changed_source = commit('lease-source', lease_head, 'lease-source-new.txt')
            git('push', '--quiet', remote, changed_source + ':refs/heads/lease-source')
            git('push', '--quiet', '--force-with-lease=refs/heads/main:' + competing,
                remote, replacement + ':refs/heads/main', actor=merger)
            assert current() == replacement
            assert git('show', '-s', '--format=%P', replacement).split() == [competing, lease_head]
            git('merge-base', '--is-ancestor', changed_source, replacement, success=False)
            check('explicit Git expected-base lease rejects stale base and publishes exact candidate; source head is not conditioned')

        print('OBSERVED: characterization complete; Golf protected-write gate remains open', flush=True)
    finally:
        failures = []
        if org_created and bootstrap_token:
            try:
                for repository in api(bootstrap_token, 'GET', f'orgs/{organization}/repos?limit=50'):
                    assert repository['owner']['login'] == organization
                    api(bootstrap_token, 'DELETE', 'repos/' + repository['full_name'], expected=204)
                api(bootstrap_token, 'DELETE', 'orgs/' + organization, expected=204)
                api(None, 'GET', 'orgs/' + organization, expected=404)
            except Exception:
                failures.append('disposable organization cleanup failed')
        for name in reversed(users):
            try:
                assert name.startswith(prefix + '-')
                if name == bootstrap:
                    # This private instance alone qualifies the known active-admin
                    # cleanup gap; never use this as a production recovery flow.
                    api(bootstrap_token, 'PATCH', 'admin/users/' + name, {'active': False})
                admin('delete', '--username', name, '--purge')
                api(None, 'GET', 'users/' + name, expected=404)
            except Exception:
                failures.append('disposable user cleanup failed')
        if failures:
            raise RuntimeError('; '.join(failures))
        check('all disposable users, organization and repositories purged')


def run_isolated(check_provider, port=3018, prefix='golf-protection', custom_hooks=False):
    global GITEA, COMPOSE
    assert 1024 <= port <= 65535
    assert prefix in ('golf-protection', 'golf-publisher')
    GITEA = 'http://localhost:' + str(port)
    project = prefix + '-proof-' + secrets.token_hex(5)
    with tempfile.TemporaryDirectory(prefix=prefix + '-provider-') as temporary:
        path = Path(temporary)
        environment = path / 'runtime.env'
        descriptor = os.open(environment, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD'):
                output.write(key + '=' + secrets.token_urlsafe(32) + '\n')
        compose = path / 'compose.json'
        spec = {'services': {
            'postgres': {
                'image': 'postgres:18.4-alpine3.24',
                'environment': {key: '${' + key + '}' for key in ('POSTGRES_PASSWORD', 'GOLF_DB_PASSWORD', 'GITEA_DB_PASSWORD')},
                'volumes': ['postgres-data:/var/lib/postgresql', str(ROOT / 'deploy/postgres/init.sh') + ':/docker-entrypoint-initdb.d/01-golf.sh:ro'],
                'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres'], 'interval': '2s', 'timeout': '3s', 'retries': 45}},
            'gitea': {
                'image': 'gitea/gitea:1.27.3-rootless',
                'environment': {
                    'GITEA__database__DB_TYPE': 'postgres', 'GITEA__database__HOST': 'postgres:5432',
                    'GITEA__database__NAME': 'gitea', 'GITEA__database__USER': 'gitea',
                    'GITEA__database__PASSWD': '${GITEA_DB_PASSWORD}',
                    'GITEA__server__ROOT_URL': GITEA + '/',
                    'GITEA__security__INSTALL_LOCK': 'true', 'GITEA__service__DISABLE_REGISTRATION': 'true',
                    'GITEA__actions__ENABLED': 'false'},
                'ports': ['127.0.0.1:' + str(port) + ':3000'],
                'volumes': ['gitea-data:/var/lib/gitea', 'gitea-config:/etc/gitea'],
                'depends_on': {'postgres': {'condition': 'service_healthy'}}}},
            'volumes': {'postgres-data': {}, 'gitea-data': {}, 'gitea-config': {}}}
        if custom_hooks:
            assert prefix == 'golf-publisher', 'Custom hooks are isolated publisher-fixture only'
            spec['services']['gitea']['environment']['GITEA__security__DISABLE_GIT_HOOKS'] = 'false'
        compose.write_text(json.dumps(spec))
        COMPOSE = ['docker', 'compose', '-p', project, '--env-file', str(environment), '-f', str(compose)]
        try:
            command(*COMPOSE, 'up', '-d')
            deadline = time.monotonic() + 90
            while True:
                try:
                    if api(None, 'GET', 'version')['version'] == '1.27.3':
                        break
                except (OSError, AssertionError):
                    pass
                assert time.monotonic() < deadline, 'Disposable provider startup timed out'
                time.sleep(0.5)
            check('isolated PostgreSQL18.4/Gitea1.27.3 started; existing Compose untouched')
            check_provider()
        finally:
            command(*COMPOSE, 'down', '--volumes', '--remove-orphans')
            for kind in ('container', 'volume', 'network'):
                remaining = command('docker', kind, 'ls', '--filter', 'label=com.docker.compose.project=' + project, '--quiet')
                assert not remaining, 'Disposable Docker ' + kind + ' survived cleanup'
            check('dedicated provider containers, volumes and network removed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=3018, help='unused loopback port for the disposable provider (default 3018)')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    run_isolated(qualify, args.port)


if __name__ == '__main__':
    main()
