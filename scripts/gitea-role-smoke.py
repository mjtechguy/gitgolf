#!/usr/bin/env python3
"""Qualify Gitea 1.27.3 roles in an entirely disposable PostgreSQL/Gitea instance.

Creates only randomly prefixed disposable users/org/repositories through supported
CLI/API and Git, then purges them. Does not modify Golf, existing accounts, site
configuration, Gitea database tables or repository files directly. User credentials
stay in memory/environment; provider passwords use a temporary 0600 environment
file. No passwords/tokens in command arguments/output.
"""
import argparse
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
SCOPES = 'read:user,write:organization,write:repository,write:issue'


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
        expected = (expected,) if isinstance(expected, int) else expected
        assert response.status in expected, f'{method} {route}: {response.status}, expected {expected}'
        return json.loads(raw) if raw else None


def token_for(name, scopes=SCOPES):
    value = admin('generate-access-token', '--username', name, '--token-name',
                  'golf-role-proof-' + secrets.token_hex(4), '--scopes', scopes, '--raw')
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


def qualify():
    assert api(None, 'GET', 'version')['version'] == '1.27.3', 'This proof requires pinned Gitea 1.27.3'
    suffix = secrets.token_hex(5)
    prefix = 'golf-role-' + suffix
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
        for role in ('owner', 'admin', 'developer', 'reporter', 'viewer', 'issues', 'code', 'outsider'):
            name = prefix + '-' + role
            identity = api(bootstrap_token, 'POST', 'admin/users', {
                'username': name, 'email': name + '@example.invalid',
                'password': secrets.token_urlsafe(32), 'must_change_password': False,
                'send_notify': False, 'visibility': 'private'}, expected=201)
            users.append(name)
            assert identity['login'] == name and identity['is_admin'] is False, 'Role user accidentally became a site admin'
            records[role] = {'name': name, 'token': token_for(name), 'id': identity['id']}
        owner = records['owner']['token']
        api(owner, 'POST', 'orgs', {'username': organization, 'visibility': 'private',
            'description': 'Disposable Golf role qualification', 'repo_admin_change_team_access': False}, expected=201)
        org_created = True
        teams = api(owner, 'GET', f'orgs/{organization}/teams?limit=50')
        owners = next(team for team in teams if team['name'] == 'Owners')
        assert owners['permission'] == 'owner'
        repo = api(owner, 'POST', f'orgs/{organization}/repos', {
            'name': 'private-core', 'private': True, 'auto_init': True,
            'default_branch': 'main', 'description': 'Disposable role proof'}, expected=201)
        full_name = repo['full_name']
        route = 'repos/' + full_name
        remote = GITEA + '/' + full_name + '.git'
        profiles = {
            'admin': ('admin', {}),
            'developer': ('write', {'repo.code': 'write', 'repo.issues': 'write', 'repo.pulls': 'write'}),
            'reporter': ('read', {'repo.code': 'read', 'repo.issues': 'read', 'repo.pulls': 'read'}),
            'viewer': ('read', {'repo.code': 'read', 'repo.issues': 'read', 'repo.pulls': 'read'}),
            'issues': ('write', {'repo.code': 'none', 'repo.issues': 'write'}),
            'code': ('read', {'repo.code': 'read', 'repo.issues': 'none'}),
        }
        team_ids = {}
        for role, (permission, units) in profiles.items():
            data = {'name': role + '-team', 'permission': permission,
                    'includes_all_repositories': False, 'can_create_org_repo': False,
                    'visibility': 'private'}
            if units:
                data['units_map'] = units
            team = api(owner, 'POST', f'orgs/{organization}/teams', data, expected=201)
            team_ids[role] = team['id']
            assert team['permission'] == ('none' if units else permission), f'Role {role}: unexpected legacy permission summary'
            assert not team['includes_all_repositories']
            for unit, level in units.items():
                assert team['units_map'].get(unit, 'none') == level, f'Role {role}: unit mapping changed'
            api(owner, 'PUT', f'teams/{team["id"]}/members/{records[role]["name"]}', expected=204)
            api(owner, 'PUT', f'teams/{team["id"]}/repos/{full_name}', expected=204)
        # Empty private-org membership without a repository grant must not reveal it.
        orphan = api(owner, 'POST', f'orgs/{organization}/teams', {
            'name': 'unassigned-team', 'permission': 'read', 'units_map': {'repo.code': 'read'},
            'includes_all_repositories': False}, expected=201)
        api(owner, 'PUT', f'teams/{orphan["id"]}/members/{records["outsider"]["name"]}', expected=204)
        api(records['outsider']['token'], 'GET', route, expected=404)
        api(None, 'GET', route, expected=404)
        api(bootstrap_token, 'GET', route)  # Site admin is deliberately distinct from org/repo roles.
        check('private organization membership grants no repository access; site-admin bypass is separate')
        deadline = time.monotonic() + 30
        while api(owner, 'GET', route)['empty']:
            assert time.monotonic() < deadline, 'Initial repository processing timed out'
            time.sleep(0.2)
        issue = api(owner, 'POST', route + '/issues', {'title': 'Owner-created issue', 'body': 'Private fixture'}, expected=201)
        with tempfile.TemporaryDirectory(prefix='golf-role-git-') as temporary:
            home = Path(temporary)
            work = home / 'source'
            command('git', 'clone', '--quiet', remote, str(work), env=git_env(records['owner']))
            revision = command('git', 'rev-parse', 'HEAD', cwd=work)
            for role in ('owner', 'admin', 'developer', 'reporter', 'viewer', 'code'):
                user = records[role]
                source = api(user['token'], 'GET', route + '/contents/README.md?ref=main')
                assert source['type'] == 'file'
                refs = command('git', 'ls-remote', remote, 'refs/heads/main', env=git_env(user))
                assert refs.split()[0] == revision
                command('git', 'push', '--quiet', remote, 'HEAD:refs/heads/proof-' + role,
                        env=git_env(user), cwd=work, success=role in ('owner', 'admin', 'developer'))
            # Issue-only collaboration must not grant source access or Git fetch.
            api(records['issues']['token'], 'GET', route + '/issues')
            api(records['issues']['token'], 'GET', route + '/contents/README.md?ref=main', expected=403)
            command('git', 'ls-remote', remote, env=git_env(records['issues']), success=False)
            api(records['code']['token'], 'GET', route + '/issues', expected=404)
            check('per-user Git and API enforce code read/write and independent issue-only/code-only grants')
            for role in ('reporter', 'viewer'):
                token = records[role]['token']
                created = api(token, 'POST', route + '/issues', {'title': role + ' can report with Issues read'}, expected=201)
                api(token, 'POST', route + f'/issues/{issue["number"]}/comments', {'body': role + ' can comment'}, expected=201)
                api(token, 'PATCH', route + f'/issues/{issue["number"]}', {'title': 'Unauthorized edit'}, expected=403)
                api(token, 'PATCH', route + f'/issues/{created["number"]}', {'title': role + ' can edit own report'}, expected=201)
            limited_viewer = token_for(records['viewer']['name'], 'read:user,read:repository,read:issue')
            api(limited_viewer, 'GET', route + '/issues')
            api(limited_viewer, 'POST', route + '/issues', {'title': 'Scope must deny'}, expected=403)
            api(records['issues']['token'], 'PATCH', route + f'/issues/{issue["number"]}', {'title': 'Issue-writer moderation'}, expected=201)
            check('Issues read permits reports/comments/own edits; strict viewer needs more than a team mapping')
            for role in ('owner', 'admin'):
                api(records[role]['token'], 'PATCH', route, {'description': 'Changed by ' + role})
            for role in ('developer', 'reporter', 'viewer', 'issues', 'code'):
                api(records[role]['token'], 'PATCH', route, {'description': 'Forbidden'}, expected=403)
            # A repository admin is not an organization owner in the API boundary.
            api(records['admin']['token'], 'PATCH', f'orgs/{organization}', {'description': 'Forbidden'}, expected=403)
            api(records['admin']['token'], 'POST', f'orgs/{organization}/teams', {
                'name': 'forbidden-admin-team', 'permission': 'read', 'units_map': {'repo.code': 'read'}}, expected=403)
            # Check both previously vulnerable routes on the pinned fixed provider.
            api(owner, 'PUT', f'teams/{orphan["id"]}/members/{records["admin"]["name"]}', expected=204)
            api(records['admin']['token'], 'PUT', f'teams/{orphan["id"]}/repos/{full_name}', expected=403)
            api(records['admin']['token'], 'PUT', route + '/teams/unassigned-team', expected=403)
            api(records['outsider']['token'], 'GET', route, expected=404)
            api(owner, 'POST', f'orgs/{organization}/repos', {'name': 'admin-delete-proof', 'private': True}, expected=201)
            api(owner, 'PUT', f'teams/{team_ids["admin"]}/repos/{organization}/admin-delete-proof', expected=204)
            api(records['admin']['token'], 'DELETE', f'repos/{organization}/admin-delete-proof', expected=204)
            check('repository admin settings/deletion exceed maintainer; org ownership and team-link restriction remain enforced')
            # Grants are additive. Removing write must keep a separate read grant.
            developer = records['developer']
            api(owner, 'PUT', f'teams/{team_ids["viewer"]}/members/{developer["name"]}', expected=204)
            api(owner, 'DELETE', f'teams/{team_ids["developer"]}/members/{developer["name"]}', expected=204)
            api(developer['token'], 'GET', route + '/contents/README.md?ref=main')
            command('git', 'ls-remote', remote, env=git_env(developer))
            command('git', 'push', '--quiet', remote, 'HEAD:refs/heads/revoked-write',
                    env=git_env(developer), cwd=work, success=False)
            api(owner, 'DELETE', f'teams/{team_ids["viewer"]}/members/{developer["name"]}', expected=204)
            api(developer['token'], 'GET', 'user')  # Token remains valid; permission was revoked.
            api(developer['token'], 'GET', route, expected=404)
            api(developer['token'], 'GET', route + '/contents/README.md?ref=main', expected=404)
            command('git', 'ls-remote', remote, env=git_env(developer), success=False)
            api(owner, 'DELETE', f'orgs/{organization}/members/{records["reporter"]["name"]}', expected=204)
            api(records['reporter']['token'], 'GET', route + '/issues', expected=404)
            command('git', 'ls-remote', remote, env=git_env(records['reporter']), success=False)
            check('additive grants, team removal and organization removal revoke existing-token Git/API access')
        # Gitea returns an internal error for its final-owner guard. Verify state,
        # not only the status code, so a provider exception cannot count as proof.
        api(owner, 'DELETE', f'teams/{owners["id"]}/members/{records["owner"]["name"]}', expected=500)
        remaining = api(owner, 'GET', f'teams/{owners["id"]}/members?limit=50')
        assert [user['id'] for user in remaining] == [records['owner']['id']]
        api(owner, 'DELETE', f'orgs/{organization}/members/{records["owner"]["name"]}', expected=500)
        remaining = api(owner, 'GET', f'teams/{owners["id"]}/members?limit=50')
        assert len(remaining) == 1 and remaining[0]['id'] == records['owner']['id']
        backup = records['outsider']
        api(bootstrap_token, 'PATCH', 'admin/users/' + backup['name'], {'prohibit_login': True})
        api(backup['token'], 'GET', 'user', expected=403)
        api(owner, 'PUT', f'teams/{owners["id"]}/members/{backup["name"]}', expected=204)
        api(owner, 'DELETE', f'teams/{owners["id"]}/members/{records["owner"]["name"]}', expected=204)
        remaining = api(bootstrap_token, 'GET', f'teams/{owners["id"]}/members?limit=50')
        assert len(remaining) == 1 and remaining[0]['id'] == backup['id']
        # Restore immediately through the disposable administrator before cleanup.
        api(bootstrap_token, 'PUT', f'teams/{owners["id"]}/members/{records["owner"]["name"]}', expected=204)
        api(owner, 'DELETE', f'teams/{owners["id"]}/members/{backup["name"]}', expected=204)
        api(bootstrap_token, 'PATCH', 'admin/users/' + backup['name'], {'prohibit_login': False})
        check('last-owner count guard holds sequentially but does not ensure a login-capable recoverable owner')
        command(*COMPOSE, 'exec', '-T', 'gitea', 'gitea', '--config', '/etc/gitea/app.ini',
                'admin', 'user', 'delete', '--username', bootstrap, '--purge', success=False)
        assert api(bootstrap_token, 'GET', 'user')['is_admin'] is True
        check('deleting the last active site administrator is denied; cleanup separately qualifies self-deactivation gap')
        check('pinned Gitea role qualification complete; no Golf role/domain implementation implied')
    finally:
        failures = []
        if org_created and bootstrap_token:
            try:
                repositories = api(bootstrap_token, 'GET', f'orgs/{organization}/repos?limit=50')
                assert len(repositories) < 50, 'Unexpected fixture repository count'
                for repository in repositories:
                    assert repository['owner']['login'] == organization
                    api(bootstrap_token, 'DELETE', 'repos/' + repository['full_name'], expected=204)
                api(bootstrap_token, 'DELETE', 'orgs/' + organization, expected=204)
                api(None, 'GET', 'orgs/' + organization, expected=404)
            except Exception:
                failures.append('temporary organization cleanup failed: ' + organization)
        for name in reversed(users):
            try:
                assert name.startswith(prefix + '-')
                if name == bootstrap:
                    # Only this disposable provider: inactive administrators bypass
                    # the deletion guard. This is a recovery-safety qualification,
                    # never a production bootstrap or cleanup recommendation.
                    api(bootstrap_token, 'PATCH', 'admin/users/' + bootstrap, {'active': False})
                admin('delete', '--username', name, '--purge')
                api(None, 'GET', 'users/' + name, expected=404)
            except Exception:
                failures.append('temporary user cleanup failed: ' + name)
        if failures:
            raise RuntimeError('; '.join(failures))
        if users:
            check('all disposable users, organization and repositories purged')


def main():
    global GITEA, COMPOSE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=3016, help='unused loopback port for the disposable provider (default 3016)')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    GITEA = 'http://localhost:' + str(args.port)
    project = 'golf-role-proof-' + secrets.token_hex(5)
    with tempfile.TemporaryDirectory(prefix='golf-role-provider-') as temporary:
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
                'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U postgres'], 'interval': '2s', 'timeout': '3s', 'retries': 45}},
            'gitea': {
                'image': 'gitea/gitea:1.27.3-rootless',
                'environment': {
                    'GITEA__database__DB_TYPE': 'postgres', 'GITEA__database__HOST': 'postgres:5432',
                    'GITEA__database__NAME': 'gitea', 'GITEA__database__USER': 'gitea',
                    'GITEA__database__PASSWD': '${GITEA_DB_PASSWORD}',
                    'GITEA__server__ROOT_URL': GITEA + '/',
                    'GITEA__security__INSTALL_LOCK': 'true', 'GITEA__service__DISABLE_REGISTRATION': 'true',
                    'GITEA__actions__ENABLED': 'false'},
                'ports': ['127.0.0.1:' + str(args.port) + ':3000'],
                'volumes': ['gitea-data:/var/lib/gitea', 'gitea-config:/etc/gitea'],
                'depends_on': {'postgres': {'condition': 'service_healthy'}}}},
            'volumes': {'postgres-data': {}, 'gitea-data': {}, 'gitea-config': {}}}
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
            qualify()
        finally:
            command(*COMPOSE, 'down', '--volumes', '--remove-orphans')
            for kind in ('container', 'volume', 'network'):
                remaining = command('docker', kind, 'ls', '--filter', 'label=com.docker.compose.project=' + project, '--quiet')
                assert not remaining, 'Disposable Docker ' + kind + ' survived cleanup'
            check('dedicated provider containers, volumes and network removed')


if __name__ == '__main__':
    main()
