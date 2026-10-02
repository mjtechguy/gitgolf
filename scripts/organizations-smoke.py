#!/usr/bin/env python3
"""Exercise member-scoped organization/team reads against the actual Compose stack.

Disposable ordinary users, organizations and repositories only. Credentials stay
in memory; no database, configuration or .env edits. Never prints provider bodies.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
from smoke import GITEA, GOLF, ROOT, admin, client, ready, rpc


BROWSER_CHECK = r'''
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
let browser, context, config, stage = 'browser dependencies';
function check(value) { if (!value) throw new Error('Browser assertion failed'); }
try {
  const { chromium } = await import(pathToFileURL(join(process.cwd(), 'web/node_modules/playwright/index.mjs')));
  let input = ''; for await (const part of process.stdin) input += part;
  config = JSON.parse(input); input = '';
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', () => errors.push('runtime error'));
  stage = 'actual sign-in';
  await page.goto(config.golf);
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Gitea access token', { exact: true }).fill(config.memberToken);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('link', { name: 'Organizations', exact: true }).click();
  await page.getByRole('link', { name: config.organization, exact: true }).click();
  await page.getByRole('link', { name: 'readers', exact: true }).click();
  stage = 'real team detail and private lists';
  await page.getByRole('heading', { name: 'readers', exact: true }).waitFor();
  await page.getByRole('heading', { name: config.member, exact: true }).waitFor();
  await page.getByRole('link', { name: config.organization + '/first', exact: true }).waitFor();
  check(await page.getByText('repo.code', { exact: true }).count() === 1);
  check(await page.getByText('hidden-team', { exact: true }).count() === 0);
  check((await page.locator('.organization-permission-note').innerText()).includes('not a computed effective Golf role'));
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await page.screenshot({ path: join(config.screenshots, 'organizations-dark.png'), fullPage: true });
  stage = 'typed deep-link reload and mobile';
  await page.reload();
  await page.getByRole('heading', { name: 'readers', exact: true }).waitFor();
  check(new URL(page.url()).searchParams.get('team') === config.teamId);
  await page.getByRole('button', { name: 'Light theme', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(config.screenshots, 'organizations-light-mobile.png'), fullPage: true });
  stage = 'repository source navigation';
  await page.getByRole('link', { name: config.organization + '/first', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/repositories/' + config.organization + '/first');
  await page.locator('.repository-intro h1').filter({ hasText: 'first' }).waitFor();
  stage = 'return to team detail';
  await page.goBack();
  await page.getByRole('heading', { name: 'readers', exact: true }).waitFor();
  stage = 'real membership revocation and private-data removal';
  const removed = await context.request.delete(config.gitea + '/api/v1/orgs/' + config.organization + '/members/' + config.member,
    { headers: { Authorization: 'token ' + config.ownerToken } });
  check(removed.status() === 204);
  await page.getByRole('button', { name: 'Refresh organization access', exact: true }).click();
  await page.getByRole('alert').waitFor();
  check(await page.getByRole('heading', { name: 'readers', exact: true }).count() === 0);
  check(await page.getByRole('heading', { name: config.member, exact: true }).count() === 0);
  check(await page.locator('.unit-permissions').count() === 0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText('Advanced token sign-in', { exact: true }).waitFor();
  check(errors.length === 0);
  console.log('PASS: production-served organization/team navigation, dark/light/mobile, source links and membership-revocation cleanup');
} catch {
  console.error('Organization browser check failed at ' + stage + '; sensitive diagnostics withheld.');
  process.exitCode = 1;
} finally {
  if (context && config) {
    try {
      const response = await context.request.post(config.golf + '/rpc/golf.v1.SessionService/Logout', {
        headers: { Origin: config.golf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' }, data: {} });
      check(response.status() === 200);
    } catch { console.error('Organization browser session cleanup failed; diagnostics withheld.'); process.exitCode = 1; }
  }
  await browser?.close();
}
'''


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def provider(token, method, path, data=None, expected=200):
    headers = {'Authorization': 'token ' + token, 'Content-Type': 'application/json'}
    req = urllib.request.Request(GITEA + '/api/v1/' + path, method=method,
        headers=headers, data=None if data is None else json.dumps(data).encode())
    try:
        response = urllib.request.build_opener(NoRedirect()).open(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.status == expected, f'Provider {method} {path}: {response.status}'
        raw = response.read((2 << 20) + 1)
        assert len(raw) <= 2 << 20, 'Provider response exceeded bound'
        return json.loads(raw) if raw else None


def call(session, procedure, data=None, expected=200):
    return rpc(session, 'OrganizationService/' + procedure, data or {}, expected=expected)


def cli_call(binary, token, arguments, expected=0):
    environment = {key: value for key, value in os.environ.items() if key not in {'GOLF_GITEA_TOKEN', 'GOLF_API_TOKEN'}}
    environment['GOLF_URL'] = GOLF
    result = subprocess.run([str(binary), '--token-stdin', *arguments], input=token + '\n',
        cwd=ROOT, env=environment, text=True, capture_output=True, timeout=30)
    assert result.returncode == expected, 'CLI exit status mismatch; diagnostics withheld'
    assert token not in result.stdout and token not in result.stderr, 'CLI exposed its credential'
    if expected:
        assert not result.stdout, 'Denied CLI operation emitted private data'
        return None
    envelope = json.loads(result.stdout)
    assert envelope['schema_version'] == 'golf.cli.v1'
    return envelope['data']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', type=Path, help='also qualify a built CLI (for example bin/golf)')
    arguments = parser.parse_args()
    binary = arguments.cli.resolve() if arguments.cli else None
    if binary and not binary.is_file():
        parser.error('--cli must name an existing binary; run make cli first')
    ready()
    prefix = 'golf-org-' + secrets.token_hex(5)
    users, organizations = [], []
    token = None
    try:
        actors = {}
        for role in ['owner', 'member', 'outsider']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name + '@example.invalid',
                '--random-password', '--random-password-length', '32', '--must-change-password=false')
            users.append(name)
            scopes = 'read:user,write:organization,write:repository,read:issue' if role == 'owner' else 'read:user,read:organization,read:repository,read:issue'
            credential = admin('generate-access-token', '--username', name, '--token-name', prefix,
                '--scopes', scopes, '--raw').strip()
            session = client()
            rpc(session, 'SessionService/LoginWithGiteaToken', {'token': credential})
            actors[role] = {'name': name, 'token': credential, 'session': session}
        owner, member, outsider = [actors[role] for role in ['owner', 'member', 'outsider']]
        token = owner['token']
        for suffix, visibility in [('private', 'private'), ('public', 'public')]:
            name = prefix + '-' + suffix
            org = provider(token, 'POST', 'orgs', {'username': name, 'visibility': visibility,
                'description': 'Plain text <script> fixture', 'repo_admin_change_team_access': False}, expected=201)
            organizations.append(name)
            assert org['name'] == name
        organization, public = organizations
        reader = provider(token, 'POST', 'orgs/' + organization + '/teams', {
            'name': 'readers', 'permission': 'read', 'visibility': 'private',
            'units_map': {'repo.code': 'read', 'repo.issues': 'read'},
            'includes_all_repositories': False}, expected=201)
        hidden = provider(token, 'POST', 'orgs/' + organization + '/teams', {
            'name': 'hidden-team', 'permission': 'write', 'visibility': 'private',
            'units_map': {'repo.code': 'write'}, 'includes_all_repositories': False}, expected=201)
        other_team = provider(token, 'POST', 'orgs/' + public + '/teams', {
            'name': 'public-team', 'permission': 'read', 'visibility': 'public',
            'units_map': {'repo.code': 'read'}, 'includes_all_repositories': False}, expected=201)
        team_id = str(reader['id'])
        provider(token, 'PUT', f'teams/{team_id}/members/{member["name"]}', expected=204)
        repositories = []
        for name in ['first', 'second']:
            repo = provider(token, 'POST', 'orgs/' + organization + '/repos', {
                'name': name, 'private': True, 'auto_init': False}, expected=201)
            repositories.append(str(repo['id']))
            provider(token, 'PUT', f'teams/{team_id}/repos/{organization}/{name}', expected=204)

        first = call(owner['session'], 'ListOrganizations', {'page': {'limit': 1}})
        assert len(first['organizations']) == 1 and first['page']['nextPage'] == 2
        second = call(owner['session'], 'ListOrganizations', {'page': {'limit': 1, 'page': 2}})
        assert {row['name'] for row in first['organizations'] + second['organizations']} == set(organizations)
        assert [row['name'] for row in call(member['session'], 'ListOrganizations')['organizations']] == [organization]
        assert not call(outsider['session'], 'ListOrganizations').get('organizations', [])
        assert call(member['session'], 'GetOrganization', {'organization': organization})['organization']['visibility'] == 'ORGANIZATION_VISIBILITY_PRIVATE'
        # A public provider object is not sufficient for Golf's membership gate.
        provider(outsider['token'], 'GET', 'orgs/' + public)
        call(outsider['session'], 'GetOrganization', {'organization': public}, expected=404)
        call(outsider['session'], 'ListTeams', {'organization': public}, expected=404)
        call(outsider['session'], 'GetTeam', {'organization': public, 'teamId': str(other_team['id'])}, expected=404)
        print('PASS: own organizations paginate; public provider metadata does not bypass Golf membership', flush=True)

        teams = call(member['session'], 'ListTeams', {'organization': organization})['teams']
        assert team_id in {row['id'] for row in teams}
        assert str(hidden['id']) not in {row['id'] for row in teams}, 'Private team disclosure'
        team = call(member['session'], 'GetTeam', {'organization': organization, 'teamId': team_id})['team']
        assert team['visibility'] == 'TEAM_VISIBILITY_PRIVATE'
        assert team['permission'] == 'TEAM_PERMISSION_NONE'
        assert team['unitPermissions']['repo.code'] == 'TEAM_PERMISSION_READ'
        call(member['session'], 'GetTeam', {'organization': organization, 'teamId': str(hidden['id'])}, expected=403)
        call(owner['session'], 'GetTeam', {'organization': organization, 'teamId': str(other_team['id'])}, expected=404)
        for procedure in ['ListTeamMembers', 'ListTeamRepositories']:
            call(owner['session'], procedure, {'organization': organization, 'teamId': str(other_team['id'])}, expected=404)
            call(member['session'], procedure, {'organization': organization, 'teamId': str(hidden['id'])}, expected=403)
        members = call(member['session'], 'ListTeamMembers', {'organization': organization, 'teamId': team_id})['members']
        assert [row['login'] for row in members] == [member['name']]
        first = call(member['session'], 'ListTeamRepositories', {'organization': organization, 'teamId': team_id, 'page': {'limit': 1}})
        assert first['page']['nextPage'] == 2
        second = call(member['session'], 'ListTeamRepositories', {'organization': organization, 'teamId': team_id, 'page': {'limit': 1, 'page': 2}})
        assert {row['id'] for row in first['repositories'] + second['repositories']} == set(repositories)
        print('PASS: team visibility, immutable organization binding, native unit metadata and member/repository reads', flush=True)

        if binary:
            before = {row['id'] for row in rpc(member['session'], 'SessionService/ListSessions')['sessions']}
            listed = cli_call(binary, member['token'], ['org', 'list', '--limit', '1'])
            assert [row['name'] for row in listed['organizations']] == [organization]
            viewed = cli_call(binary, member['token'], ['org', 'view', organization])
            assert viewed['organization']['visibility'] == 'ORGANIZATION_VISIBILITY_PRIVATE'
            teams_cli = cli_call(binary, member['token'], ['org', 'teams', organization])
            assert team_id in {row['id'] for row in teams_cli['teams']}
            detail = cli_call(binary, member['token'], ['team', 'view', organization, team_id])
            assert detail['team']['permission'] == 'TEAM_PERMISSION_NONE'
            assert detail['team']['unitPermissions']['repo.code'] == 'TEAM_PERMISSION_READ'
            assert [row['login'] for row in cli_call(binary, member['token'],
                ['team', 'members', organization, team_id])['members']] == [member['name']]
            one = cli_call(binary, member['token'], ['team', 'repos', organization, team_id, '--limit', '1'])
            two = cli_call(binary, member['token'], ['team', 'repos', organization, team_id, '--limit', '1', '--page', '2'])
            assert one['page']['nextPage'] == 2 and {row['id'] for row in one['repositories'] + two['repositories']} == set(repositories)
            cli_call(binary, member['token'], ['team', 'view', organization, str(hidden['id'])], expected=1)
            cli_call(binary, owner['token'], ['team', 'view', organization, str(other_team['id'])], expected=1)
            cli_call(binary, member['token'], ['team', 'view', organization, '01'], expected=2)
            assert {row['id'] for row in rpc(member['session'], 'SessionService/ListSessions')['sessions']} == before
            print('PASS: six real CLI organization/team commands, string IDs, native unit JSON, pagination and denied-output/session cleanup', flush=True)

        for bad in ['0', '01', '-1', '9223372036854775808', '../1']:
            call(member['session'], 'GetTeam', {'organization': organization, 'teamId': bad}, expected=400)
        call(member['session'], 'GetOrganization', {'organization': '../org'}, expected=400)
        call(member['session'], 'ListOrganizations', {'page': {'limit': 101}}, expected=400)
        call(client(), 'ListOrganizations', expected=401)
        narrow_token = admin('generate-access-token', '--username', member['name'], '--token-name', prefix + '-narrow',
            '--scopes', 'read:user,read:repository', '--raw').strip()
        narrow = client()
        rpc(narrow, 'SessionService/LoginWithGiteaToken', {'token': narrow_token})
        call(narrow, 'ListOrganizations', expected=403)
        if binary:
            cli_call(binary, narrow_token, ['org', 'list'], expected=1)
        rpc(narrow, 'SessionService/Logout')
        print('PASS: malformed IDs/names/pagination, anonymous requests and missing organization scope are rejected', flush=True)

        screenshots = ROOT / '.tmp/organization-smoke'
        screenshots.mkdir(parents=True, exist_ok=True)
        config = {'golf': GOLF, 'gitea': GITEA, 'organization': organization, 'teamId': team_id,
            'member': member['name'], 'memberToken': member['token'], 'ownerToken': token,
            'screenshots': str(screenshots)}
        result = subprocess.run(['node', '--input-type=module', '-e', BROWSER_CHECK], cwd=ROOT,
            input=json.dumps(config), text=True, capture_output=True, timeout=120)
        if result.returncode:
            # The embedded script only emits a fixed stage and withholds raw errors.
            print(result.stderr.strip(), file=sys.stderr)
            raise AssertionError('Real organization browser check failed')
        print(result.stdout.strip(), flush=True)
        provider(token, 'GET', f'orgs/{organization}/members/{member["name"]}', expected=404)
        rpc(member['session'], 'SessionService/GetSession')
        assert not call(member['session'], 'ListOrganizations').get('organizations', [])
        for procedure, data in [
            ('GetOrganization', {'organization': organization}), ('ListTeams', {'organization': organization}),
            ('GetTeam', {'organization': organization, 'teamId': team_id}),
            ('ListTeamMembers', {'organization': organization, 'teamId': team_id}),
            ('ListTeamRepositories', {'organization': organization, 'teamId': team_id}),
        ]:
            call(member['session'], procedure, data, expected=404)
        print('PASS: membership removal denies subsequent reads while the provider session still authenticates', flush=True)
        if binary:
            cli_call(binary, member['token'], ['org', 'view', organization], expected=1)
            cli_call(binary, member['token'], ['team', 'members', organization, team_id], expected=1)
            assert not cli_call(binary, member['token'], ['org', 'list'])['organizations']
        for actor in actors.values():
            rpc(actor['session'], 'SessionService/Logout')
    finally:
        failures = []
        for actor in actors.values():
            try:
                rpc(actor['session'], 'SessionService/Logout')
            except Exception:
                failures.append('session cleanup')
        for name in reversed(organizations):
            try:
                assigned = provider(token, 'GET', 'orgs/' + name + '/repos?limit=100')
                assert len(assigned) < 100, 'Unexpected fixture repository count'
                for repository in assigned:
                    assert repository['full_name'].startswith(name + '/')
                    provider(token, 'DELETE', 'repos/' + repository['full_name'], expected=204)
                provider(token, 'DELETE', 'orgs/' + name, expected=204)
            except Exception:
                failures.append('organization cleanup')
        for name in reversed(users):
            try:
                admin('delete', '--username', name, '--purge')
            except Exception:
                failures.append('user cleanup')
        assert not failures, 'Disposable fixture cleanup failed'
        print('Disposable organization fixtures removed.', flush=True)


if __name__ == '__main__':
    main()
