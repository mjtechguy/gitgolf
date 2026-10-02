#!/usr/bin/env python3
"""Verify real Gitea browser OAuth against the local Compose stack.

Requires the built OAuth-capable Golf image, web/node_modules and Playwright's
Chromium. Creates disposable Gitea users/application, temporarily enables Golf
OAuth, then restores the original disabled configuration. --refresh also
recreates Gitea with 15-second access tokens to qualify Golf's rotating refresh
flow. This interrupts local services; it never changes .env or removes volumes.
Credentials stay in memory or a mode-0600 temporary Compose override. Browser
traces, credential bodies, callback URLs and child-process diagnostics are never
printed. Run scripts/smoke.py separately for the broader Git/browser contract.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import urllib.parse

sys.dont_write_bytecode = True
from smoke import GITEA, GOLF, ROOT, admin, client, command, ready, request, rpc


# Runs in isolated Chromium contexts, using the application's actual button and
# Gitea's login/consent forms. Config arrives on stdin, never in source or argv.
BROWSER_CHECK = r'''
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
let stage = 'load browser dependencies';
let browser;
class CheckFailure extends Error {}
function check(value, message) { if (!value) throw new CheckFailure(message); }
try {
  const { chromium } = await import(pathToFileURL(join(process.cwd(), 'web/node_modules/playwright/index.mjs')));
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  input = '';
  const golf = config.golf, gitea = config.gitea;
  const callback = golf + '/auth/gitea/callback';
  const headers = { Origin: golf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' };
  async function rpc(context, procedure, body = {}, status = 200, code) {
    const response = await context.request.post(golf + '/rpc/golf.v1.' + procedure, { headers, data: body });
    check(response.status() === status, procedure + ' expected HTTP ' + status + ', received ' + response.status());
    check(response.headers()['cache-control'] === 'no-store', 'RPC caching is not disabled');
    const result = await response.json();
    if (code) check(result.code === code, 'RPC returned unexpected error code');
    return result;
  }
  async function authFailure(context, url) {
    const response = await context.request.get(url, { maxRedirects: 0 });
    check([302, 303].includes(response.status()), 'Callback did not redirect');
    const destination = new URL(response.headers().location, golf);
    check(destination.origin === golf && destination.pathname === '/' && destination.search === '?auth_error=oauth_failed', 'Callback failure escaped the fixed destination');
    check(response.headers()['cache-control'] === 'no-store', 'Callback caching is not disabled');
  }
  function validateAuthorization(value) {
    const url = new URL(value);
    check(url.origin === gitea && url.pathname === '/login/oauth/authorize', 'Authorization destination mismatch');
    check(url.searchParams.get('client_id') === config.clientID, 'OAuth client mismatch');
    check(url.searchParams.get('redirect_uri') === callback, 'OAuth callback mismatch');
    check(url.searchParams.get('response_type') === 'code' && url.searchParams.get('code_challenge_method') === 'S256', 'OAuth code/PKCE parameters missing');
    check(/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? ''), 'Invalid PKCE challenge');
    check((url.searchParams.get('state') ?? '').length >= 32, 'OAuth state missing');
    check(!url.searchParams.has('client_secret') && !url.searchParams.has('code_verifier'), 'OAuth secret exposed in authorization URL');
    check(url.searchParams.get('scope').split(' ').sort().join(' ') === config.scopes.slice().sort().join(' '), 'Unexpected OAuth scope grant');
    return url;
  }
  async function login(context, credentials, approve = true) {
    const loginStage = stage;
    const page = await context.newPage();
    let callbackURL = '', authorizationURL = '';
    page.on('request', request => {
      if (request.url().startsWith(callback + '?')) callbackURL = request.url();
      if (request.url().startsWith(gitea + '/login/oauth/authorize?')) authorizationURL = request.url();
    });
    stage = loginStage + ': Golf login page';
    await page.goto(golf);
    stage = loginStage + ': Golf OAuth button';
    const button = page.getByRole('button', { name: 'Continue with Gitea', exact: true });
    await button.waitFor({ state: 'visible' });
    stage = loginStage + ': Golf OAuth initiation response';
    const [begin] = await Promise.all([
      page.waitForResponse(response => response.url() === golf + '/rpc/golf.v1.SessionService/BeginGiteaOAuth'),
      button.click(),
    ]);
    check(begin.status() === 200, 'OAuth initiation failed');
    stage = loginStage + ': Gitea username/password form';
    await page.locator('#user_name').waitFor({ state: 'visible' });
    // Navigation can discard the prior document's response body in Chromium.
    // Inspect the actual outgoing authorization request, without intercepting it.
    validateAuthorization(authorizationURL);
    await page.locator('#user_name').fill(credentials.name);
    await page.locator('#password').fill(credentials.password);
    stage = loginStage + ': Gitea submit password';
    await page.locator('form').filter({ has: page.locator('#user_name') }).locator('button').click();
    stage = loginStage + ': Gitea consent form';
    await page.locator('#authorize-app').waitFor({ state: 'visible' });
    const consent = await page.locator('form[action$="/login/oauth/grant"] input[name="scope"]').inputValue();
    check(consent.split(' ').sort().join(' ') === config.scopes.slice().sort().join(' '), 'Consent scope mismatch');
    stage = loginStage + ': Gitea consent redirect';
    await Promise.all([
      page.waitForURL(url => url.origin === golf && url.pathname === '/'),
      page.locator(approve ? '#authorize-app' : 'button[name="granted"][value="false"]').click(),
    ]);
    check(callbackURL, 'Browser did not use Golf OAuth callback');
    stage = loginStage + ': Golf session after callback';
    if (approve) {
      check(new URL(page.url()).search === '', 'Successful OAuth did not reach the clean landing URL');
      const result = await rpc(context, 'SessionService/GetSession');
      check(result.user.login === credentials.name, 'OAuth logged in as the wrong user');
      const cookies = await context.cookies(golf);
      const session = cookies.find(cookie => cookie.name === 'golf_session');
      check(session?.httpOnly && session.sameSite === 'Lax', 'Golf session cookie missing protections');
      check(!session.value.includes('.'), 'Browser received a provider JWT instead of an opaque session');
    } else {
      check(new URL(page.url()).search === '?auth_error=oauth_failed', 'Denied consent did not fail visibly');
      await rpc(context, 'SessionService/GetSession', {}, 401, 'unauthenticated');
    }
    // Prevent UI focus/refetch work from obscuring the deliberate expiry windows.
    await page.goto('about:blank');
    return { page, callbackURL };
  }
  browser = await chromium.launch({ headless: true });
  const options = { locale: 'en-US' };
  const alice = await browser.newContext(options);
  const bob = await browser.newContext(options);
  const stranger = await browser.newContext(options);
  for (const context of [alice, bob, stranger]) {
    context.setDefaultTimeout(20000);
    context.setDefaultNavigationTimeout(20000);
  }
  stage = 'OAuth discovery';
  const available = await rpc(alice, 'SessionService/GetAuthenticationOptions');
  check(available.giteaOauthEnabled === true && available.scopes.slice().sort().join(' ') === config.scopes.slice().sort().join(' '), 'Configured OAuth not available');
  stage = 'Alice browser login and consent';
  const aliceLogin = await login(alice, config.alice);
  stage = 'private repository and source through OAuth';
  const repository = { owner: config.alice.name, name: config.repository };
  const own = await rpc(alice, 'RepositoryService/GetRepository', { repository });
  check(own.repository.private && own.repository.fullName === config.alice.name + '/' + config.repository, 'Private repository mismatch');
  const source = await rpc(alice, 'RepositoryService/GetContents', { repository, ref: config.revision, path: config.path });
  check(source.commitId === config.revision && source.file.content === config.text, 'Private immutable source mismatch');
  const issues = await rpc(alice, 'RepositoryService/ListIssues', { repository });
  check((issues.issues ?? []).some(issue => issue.title === config.issueTitle), 'OAuth read:issue scope did not work');
  const created = await rpc(alice, 'RepositoryService/CreateRepository', { name: 'oauth-created', private: true });
  check(created.repository.private && created.repository.fullName === config.alice.name + '/oauth-created', 'OAuth write:user/write:repository scopes did not work');
  const organizations = await rpc(alice, 'OrganizationService/ListOrganizations');
  check((organizations.organizations ?? []).some(org => org.name === config.organization), 'OAuth organization scope did not return own membership');
  const organization = await rpc(alice, 'OrganizationService/GetOrganization', { organization: config.organization });
  check(organization.organization.name === config.organization, 'OAuth membership-scoped organization mismatch');
  const teams = await rpc(alice, 'OrganizationService/ListTeams', { organization: config.organization });
  const owners = (teams.teams ?? []).find(team => team.name === 'Owners');
  check(owners?.permission === 'TEAM_PERMISSION_OWNER', 'OAuth native owner team metadata missing');
  await rpc(alice, 'OrganizationService/GetTeam', { organization: config.organization, teamId: owners.id });
  const members = await rpc(alice, 'OrganizationService/ListTeamMembers', { organization: config.organization, teamId: owners.id });
  check((members.members ?? []).some(member => member.login === config.alice.name), 'OAuth team member read failed');
  await rpc(alice, 'OrganizationService/ListTeamRepositories', { organization: config.organization, teamId: owners.id });
  await rpc(bob, 'OrganizationService/GetOrganization', { organization: config.organization }, 401);
  console.log('PASS: actual Golf button, Gitea login/consent, scoped private source/issues/create and six organization/team reads');
  stage = 'OAuth session management';
  const control = await browser.newContext(options);
  control.setDefaultTimeout(20000);
  control.setDefaultNavigationTimeout(20000);
  await login(control, config.sessionUser);
  const active = (await rpc(control, 'SessionService/ListSessions')).sessions ?? [];
  check(active.length === 1 && active[0].current && active[0].credentialKind === 'oauth', 'OAuth session metadata mismatch');
  check(Object.keys(active[0]).every(key => ['id', 'createdAt', 'expiresAt', 'current', 'credentialKind'].includes(key)), 'Session metadata exposed unexpected fields');
  const noOthers = await rpc(control, 'SessionService/RevokeOtherSessions');
  check((noOthers.revokedCount ?? '0') === '0', 'Revoke-other removed the current OAuth session');
  const expired = await rpc(control, 'SessionService/RevokeSession', { sessionId: active[0].id });
  check(expired.currentSessionRevoked === true, 'OAuth session revocation did not identify current session');
  await rpc(control, 'SessionService/GetSession', {}, 401, 'unauthenticated');
  await rpc(control, 'SessionService/ListSessions', {}, 401, 'unauthenticated');
  check(!(await control.cookies(golf)).some(cookie => cookie.name === 'golf_session'), 'OAuth session cookie was not cleared');
  check((await rpc(alice, 'SessionService/GetSession')).user.login === config.alice.name, 'Session controls crossed an OAuth user boundary');
  await control.close();
  console.log('PASS: real OAuth session listing, current-preserving bulk operation and current-cookie revocation');
  stage = 'denied consent';
  await login(bob, config.bob, false);
  // A fresh context repeats the actual password and consent flow for success.
  await bob.close();
  const bobAllowed = await browser.newContext(options);
  bobAllowed.setDefaultTimeout(20000);
  bobAllowed.setDefaultNavigationTimeout(20000);
  stage = 'Bob browser login and private isolation';
  await login(bobAllowed, config.bob);
  await rpc(bobAllowed, 'OrganizationService/GetOrganization', { organization: config.organization }, 404);
  await rpc(bobAllowed, 'RepositoryService/GetRepository', { repository }, 404, 'not_found');
  await rpc(bobAllowed, 'RepositoryService/GetContents', { repository, ref: config.revision, path: config.path }, 404, 'not_found');
  await rpc(stranger, 'RepositoryService/GetContents', { repository, ref: config.revision, path: config.path }, 401, 'unauthenticated');
  const bobList = await rpc(bobAllowed, 'RepositoryService/ListRepositories');
  check(!(bobList.repositories ?? []).some(repo => repo.fullName === own.repository.fullName), 'Private repository crossed user boundary');
  stage = 'callback replay and browser state binding';
  await authFailure(alice, aliceLogin.callbackURL);
  check((await rpc(alice, 'SessionService/GetSession')).user.login === config.alice.name, 'Replay replaced an existing session');
  await authFailure(stranger, aliceLogin.callbackURL);
  await rpc(stranger, 'SessionService/GetSession', {}, 401, 'unauthenticated');
  const pending = validateAuthorization((await rpc(stranger, 'SessionService/BeginGiteaOAuth')).authorizationUrl);
  const state = pending.searchParams.get('state');
  const unbound = await browser.newContext(options);
  await authFailure(unbound, callback + '?code=not-a-code&state=' + encodeURIComponent(state));
  await rpc(unbound, 'SessionService/GetSession', {}, 401, 'unauthenticated');
  await unbound.close();
  const binding = await stranger.cookies(callback);
  const changedState = (state[0] === 'a' ? 'b' : 'a') + state.slice(1);
  await authFailure(stranger, callback + '?code=not-a-code&state=' + encodeURIComponent(changedState));
  await rpc(stranger, 'SessionService/GetSession', {}, 401, 'unauthenticated');
  // Consume the deliberately denied pending attempt after restoring its test
  // browser binding. No provider access/refresh credential is inspected.
  await stranger.addCookies(binding);
  await authFailure(stranger, callback + '?error=access_denied&state=' + encodeURIComponent(state));
  console.log('PASS: denied consent, direct private isolation, callback replay and state mismatch');
  if (config.refresh) {
    for (let cycle = 1; cycle <= 2; cycle++) {
      stage = 'automatic refresh expiry cycle ' + cycle;
      console.log('STEP: waiting 16 seconds for real Gitea access-token expiry');
      await new Promise(resolve => setTimeout(resolve, 16000));
      await Promise.all(Array.from({ length: 6 }, async (_, index) => {
        if (index === 0) {
          const value = await rpc(alice, 'OrganizationService/ListOrganizations');
          check((value.organizations ?? []).some(org => org.name === config.organization), 'Refreshed organization permission mismatch');
        } else if (index % 2) {
          const value = await rpc(alice, 'SessionService/GetSession');
          check(value.user.login === config.alice.name, 'Refreshed identity mismatch');
        } else {
          const value = await rpc(alice, 'RepositoryService/ListRepositories');
          check(value.repositories.some(repo => repo.fullName === own.repository.fullName), 'Refreshed repository permission mismatch');
        }
      }));
      console.log('PASS: concurrent Golf requests after expiry cycle ' + cycle + ' with rotating refresh tokens');
    }
  }
  stage = 'Gitea user consent revocation: settings page';
  await aliceLogin.page.goto(gitea + '/user/settings/applications');
  stage = 'Gitea user consent revocation: grant button';
  const grantButton = aliceLogin.page.locator('button[data-url^="/user/settings/applications/oauth2/' + config.applicationID + '/revoke/"]');
  await grantButton.waitFor({ state: 'visible' });
  const revokePath = await grantButton.getAttribute('data-url');
  check(new RegExp('^/user/settings/applications/oauth2/' + config.applicationID + '/revoke/[0-9]+$').test(revokePath), 'Unexpected grant-revocation path');
  stage = 'Gitea user consent revocation: open confirmation';
  await grantButton.click();
  stage = 'Gitea user consent revocation: confirmation button';
  // Gitea clones the confirmation template and removes its ID before showing it.
  const confirmGrant = aliceLogin.page.locator('.ui.modal:visible').filter({ hasText: 'Revoke Access' }).locator('button.ok');
  await confirmGrant.waitFor({ state: 'visible' });
  stage = 'Gitea user consent revocation: confirmation response';
  const [revoked] = await Promise.all([
    aliceLogin.page.waitForResponse(response => new URL(response.url()).pathname === revokePath),
    confirmGrant.click(),
  ]);
  check(revoked.status() === 200, 'Gitea did not revoke the user consent grant');
  stage = 'Gitea user consent revocation: removed grant';
  await grantButton.waitFor({ state: 'hidden' });
  await aliceLogin.page.goto('about:blank');
  if (config.refresh) {
    console.log('STEP: waiting 16 seconds to test expiry after user consent revocation');
    await new Promise(resolve => setTimeout(resolve, 16000));
  }
  await rpc(alice, 'SessionService/GetSession', {}, 401, 'unauthenticated');
  await rpc(alice, 'RepositoryService/GetContents', { repository, ref: config.revision, path: config.path }, 401, 'unauthenticated');
  check((await rpc(bobAllowed, 'SessionService/GetSession')).user.login === config.bob.name, 'Revoking Alice affected another user grant');
  console.log('PASS: actual Gitea user consent revocation denies Alice while Bob remains authorized');
  stage = 'configured application deletion';
  const removed = await stranger.request.delete(gitea + '/api/v1/user/applications/oauth2/' + config.applicationID,
    { headers: { Authorization: config.ownerAuthorization } });
  check(removed.status() === 204, 'Could not revoke temporary OAuth application');
  if (config.refresh) {
    console.log('STEP: waiting 16 seconds to test expiry after configured client deletion');
    await new Promise(resolve => setTimeout(resolve, 16000));
  }
  // Gitea reports invalid_client at refresh after application deletion: this
  // requires operator configuration recovery, unlike user grant revocation.
  await rpc(bobAllowed, 'SessionService/GetSession', {}, config.refresh ? 503 : 401,
    config.refresh ? 'unavailable' : 'unauthenticated');
  await rpc(alice, 'SessionService/Logout');
  await rpc(bobAllowed, 'SessionService/Logout');
  await rpc(bobAllowed, 'SessionService/GetSession', {}, 401, 'unauthenticated');
  console.log('PASS: deleted OAuth client fails closed with the correct recovery class; logout clears sessions');
} catch (error) {
  // Playwright exceptions may contain redirect URLs/codes or entered values.
  const operation = ['page.waitForResponse', 'page.waitForURL', 'locator.waitFor', 'locator.click', 'locator.fill'].find(value => error.message?.startsWith(value + ':'));
  console.error('FAIL: ' + stage + (error instanceof CheckFailure ? ': ' + error.message : ' (' + (operation ?? 'diagnostics withheld') + ')'));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
'''


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(value, output)


def compose(override, *args):
    files = ['-f', str(ROOT / 'compose.yaml')]
    if override:
        files += ['-f', str(override)]
    return command('docker', 'compose', *files, *args)


def basic(user):
    return 'Basic ' + base64.b64encode((user['name'] + ':' + user['password']).encode()).decode()


def original_refresh_settings():
    # Read only these two non-secret settings. Gitea's env-to-ini startup writes
    # them persistently; restoring just the container environment is insufficient.
    script = r'''awk '
      /^\[/ { section=tolower($0); gsub(/[[:space:]\r]/,"",section) }
      section=="[oauth2]" && /=/ {
        key=$0; sub(/=.*/,"",key); gsub(/[[:space:]]/,"",key); key=toupper(key)
        if (key=="ACCESS_TOKEN_EXPIRATION_TIME" || key=="INVALIDATE_REFRESH_TOKENS") {
          value=$0; sub(/^[^=]*=/,"",value); sub(/[;#].*$/, "",value); gsub(/[[:space:]\r]/,"",value)
          print key "=" value
        }
      }' /etc/gitea/app.ini'''
    output = compose(None, 'exec', '-T', 'gitea', 'sh', '-c', script)
    # Pinned Gitea 1.27.3 defaults: modules/setting/oauth2.go.
    settings = {'ACCESS_TOKEN_EXPIRATION_TIME': '3600', 'INVALIDATE_REFRESH_TOKENS': 'false'}
    for line in output.splitlines():
        key, value = line.split('=', 1)
        settings[key] = value.strip('"').lower()
    if not settings['ACCESS_TOKEN_EXPIRATION_TIME'].isdigit() or settings['INVALIDATE_REFRESH_TOKENS'] not in ('true', 'false'):
        raise RuntimeError('Cannot safely determine original Gitea OAuth settings')
    return {'GITEA__oauth2__' + key: value for key, value in settings.items()}


def delete_application(user, app_id):
    try:
        request(client(), 'DELETE', GITEA + '/api/v1/user/applications/oauth2/' + str(app_id),
                headers={'Authorization': basic(user)}, expected=204)
    except AssertionError as error:
        # The successful browser check already revoked the application.
        if ': 404, expected 204' not in str(error):
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='also restart Gitea and qualify two real 15-second rotating-refresh cycles')
    args = parser.parse_args()
    ready()
    if rpc(client(), 'SessionService/GetAuthenticationOptions').get('giteaOauthEnabled', False):
        raise RuntimeError('This disposable smoke requires Golf OAuth to be disabled initially')
    if request(client(), 'GET', GITEA + '/api/v1/version')['version'] != '1.27.3':
        raise RuntimeError('This smoke qualifies only the pinned Gitea 1.27.3')
    if not (ROOT / 'web/node_modules/playwright/index.mjs').is_file():
        raise RuntimeError('Install web dependencies and Playwright Chromium before this smoke')
    original_settings = original_refresh_settings() if args.refresh else None
    users, app, changed = [], None, False
    organization = None
    suffix = secrets.token_hex(4)
    with tempfile.TemporaryDirectory(prefix='golf-oauth-smoke-', dir='/tmp') as directory:
        path = Path(directory)
        os.chmod(path, 0o700)
        try:
            for label in ('owner', 'alice', 'bob', 'session-control'):
                name = 'golf-oauth-' + label + '-' + suffix
                output = admin('create', '--username', name, '--email', name + '@example.invalid',
                               '--random-password', '--random-password-length', '32', '--must-change-password=false')
                user = {'name': name}
                users.append(user)
                match = re.search(r"^generated random password is '(.*)'$", output, re.MULTILINE)
                if not match:
                    raise RuntimeError('Could not capture generated test-user password')
                user['password'] = match.group(1)
            owner, alice, bob, session_user = users
            app = request(client(), 'POST', GITEA + '/api/v1/user/applications/oauth2',
                          {'name': 'Golf OAuth smoke ' + suffix, 'redirect_uris': [GOLF + '/auth/gitea/callback'],
                           'confidential_client': True, 'skip_secondary_authorization': False},
                          headers={'Authorization': basic(owner)}, expected=201)
            if not app.get('client_id') or not app.get('client_secret') or not app.get('confidential_client'):
                raise RuntimeError('Gitea did not register the confidential test application')
            organization_name = 'golf-oauth-org-' + suffix
            request(client(), 'POST', GITEA + '/api/v1/orgs',
                    {'username': organization_name, 'visibility': 'private'},
                    headers={'Authorization': basic(alice)}, expected=201)
            organization = organization_name
            repository = 'oauth-private'
            request(client(), 'POST', GITEA + '/api/v1/user/repos',
                    {'name': repository, 'private': True, 'auto_init': True, 'readme': 'Default', 'default_branch': 'main'},
                    headers={'Authorization': basic(alice)}, expected=201)
            source_path, text = 'nested space/source.txt', 'Private source from real Gitea OAuth.\n'
            source = request(client(), 'POST', GITEA + '/api/v1/repos/' + alice['name'] + '/' + repository + '/contents/' + urllib.parse.quote(source_path),
                             {'content': base64.b64encode(text.encode()).decode(), 'message': 'OAuth smoke source', 'branch': 'main'},
                             headers={'Authorization': basic(alice)}, expected=201)
            issue_title = 'OAuth scoped issue'
            request(client(), 'POST', GITEA + '/api/v1/repos/' + alice['name'] + '/' + repository + '/issues',
                    {'title': issue_title}, headers={'Authorization': basic(alice)}, expected=201)
            services = {'golf': {'environment': {'GITEA_PUBLIC_URL': GITEA, 'GITEA_OAUTH_CLIENT_ID': app['client_id'], 'GITEA_OAUTH_CLIENT_SECRET': app['client_secret']}}}
            if args.refresh:
                services['gitea'] = {'environment': {'GITEA__oauth2__ACCESS_TOKEN_EXPIRATION_TIME': '15', 'GITEA__oauth2__INVALIDATE_REFRESH_TOKENS': 'true'}}
            override = path / 'oauth.compose.json'
            private_json(override, {'services': services})
            changed = True
            print('STEP: enabling disposable OAuth configuration' + (' and 15-second access tokens' if args.refresh else ''), flush=True)
            compose(override, 'up', '-d', '--no-deps', '--force-recreate', *(['gitea', 'golf'] if args.refresh else ['golf']))
            ready()
            if args.refresh and original_refresh_settings() != services['gitea']['environment']:
                raise RuntimeError('Gitea did not apply the requested short lifetime and refresh rotation settings')
            browser_script = path / 'check.mjs'
            browser_script.write_text(BROWSER_CHECK)
            browser_script.chmod(0o600)
            config = {'golf': GOLF, 'gitea': GITEA, 'alice': alice, 'bob': bob, 'sessionUser': session_user,
                      'ownerAuthorization': basic(owner), 'clientID': app['client_id'], 'applicationID': app['id'],
                      'scopes': ['write:user', 'write:repository', 'read:issue', 'read:organization'], 'repository': repository,
                      'revision': source['commit']['sha'], 'path': source_path, 'text': text,
                      'issueTitle': issue_title, 'organization': organization, 'refresh': args.refresh}
            process = subprocess.Popen(['node', str(browser_script)], cwd=ROOT, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                process.stdin.write(json.dumps(config))
                process.stdin.close()
                for line in process.stdout:
                    if line.startswith(('PASS:', 'STEP:')):
                        print(line.rstrip(), flush=True)
                diagnostic = process.stderr.read()
                if process.wait() != 0:
                    safe = next((line for line in diagnostic.splitlines() if line.startswith('FAIL: ')), 'Browser check failed (diagnostics withheld)')
                    raise RuntimeError(safe)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        finally:
            cleanup_errors = []
            if changed:
                print('STEP: restoring normal Compose configuration', flush=True)
                try:
                    if original_settings is not None:
                        restore = path / 'restore.compose.json'
                        private_json(restore, {'services': {'gitea': {'environment': original_settings}}})
                        compose(restore, 'up', '-d', '--no-deps', '--force-recreate', 'gitea')
                    compose(None, 'up', '-d', '--no-deps', '--force-recreate', *(['gitea', 'golf'] if args.refresh else ['golf']))
                    ready()
                    if rpc(client(), 'SessionService/GetAuthenticationOptions').get('giteaOauthEnabled', False):
                        raise RuntimeError('Golf OAuth remained enabled after restoration')
                    if original_settings is not None and original_refresh_settings() != original_settings:
                        raise RuntimeError('Gitea OAuth timing settings were not restored')
                except Exception:
                    cleanup_errors.append('service configuration restoration failed; inspect local Compose state')
            if organization and len(users) > 1:
                try:
                    request(client(), 'DELETE', GITEA + '/api/v1/orgs/' + organization,
                            headers={'Authorization': basic(users[1])}, expected=204)
                except Exception:
                    cleanup_errors.append('temporary OAuth organization deletion failed')
            if app and users and 'password' in users[0]:
                try:
                    delete_application(users[0], app['id'])
                except Exception:
                    cleanup_errors.append('temporary OAuth application deletion failed')
            for user in users:
                try:
                    admin('delete', '--username', user['name'], '--purge')
                except Exception:
                    cleanup_errors.append('temporary user cleanup failed for ' + user['name'])
            if cleanup_errors:
                raise RuntimeError('; '.join(cleanup_errors))
            print('Temporary OAuth application/users/repos removed; OAuth disabled and original Gitea settings restored.', flush=True)


if __name__ == '__main__':
    main()
