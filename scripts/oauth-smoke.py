#!/usr/bin/env python3
"""Verify real Forgejo browser OAuth against the local Compose stack.

Requires the built OAuth-capable Golf image, web/node_modules and Playwright's
Chromium. Creates disposable Forgejo users/application, temporarily enables Golf
OAuth, then restores the original disabled configuration. --refresh also
recreates Forgejo with 15-second access tokens to qualify Golf's rotating refresh
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
from smoke import FORGE, GOLF, ROOT, admin, client, command, ready, request, rpc


# Runs in isolated Chromium contexts, using the application's actual button and
# Forgejo's login/consent forms. Config arrives on stdin, never in source or argv.
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
  const golf = config.golf, forge = config.forge;
  const callback = golf + '/auth/forgejo/callback';
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
  function validateAuthorization(value, scopes = config.scopes) {
    const url = new URL(value);
    check(url.origin === forge && url.pathname === '/login/oauth/authorize', 'Authorization destination mismatch');
    check(url.searchParams.get('client_id') === config.clientID, 'OAuth client mismatch');
    check(url.searchParams.get('redirect_uri') === callback, 'OAuth callback mismatch');
    check(url.searchParams.get('response_type') === 'code' && url.searchParams.get('code_challenge_method') === 'S256', 'OAuth code/PKCE parameters missing');
    check(/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? ''), 'Invalid PKCE challenge');
    check((url.searchParams.get('state') ?? '').length >= 32, 'OAuth state missing');
    check(!url.searchParams.has('client_secret') && !url.searchParams.has('code_verifier'), 'OAuth secret exposed in authorization URL');
    check(url.searchParams.get('scope').split(' ').sort().join(' ') === scopes.slice().sort().join(' '), 'Unexpected OAuth scope grant');
    return url;
  }
  async function login(context, credentials, approve = true, scopes = config.scopes, expectConsent = true) {
    const loginStage = stage;
    const page = await context.newPage();
    let callbackURL = '', authorizationURL = '', reducedAuthorizationURL = '';
    if (scopes !== config.scopes) {
      // Deliberately obtain a real narrower provider grant equivalent to the
      // pre-organization-scope release. State/PKCE/callback stay unchanged.
      await page.route(forge + '/login/oauth/authorize?**', async route => {
        const url = validateAuthorization(route.request().url());
        url.searchParams.set('scope', scopes.join(' '));
        reducedAuthorizationURL = url.href;
        await route.continue({ url: url.href });
      });
    }
    page.on('request', request => {
      if (request.url().startsWith(callback + '?')) callbackURL = request.url();
      if (request.url().startsWith(forge + '/login/oauth/authorize?')) authorizationURL = request.url();
    });
    stage = loginStage + ': Golf login page';
    await page.goto(golf);
    stage = loginStage + ': Golf OAuth button';
    const button = page.getByRole('button', { name: 'Continue with provider', exact: true });
    await button.waitFor({ state: 'visible' });
    stage = loginStage + ': Golf OAuth initiation response';
    const [begin] = await Promise.all([
      page.waitForResponse(response => response.url() === golf + '/rpc/golf.v1.SessionService/BeginForgeOAuth'),
      button.click(),
    ]);
    check(begin.status() === 200, 'OAuth initiation failed');
    stage = loginStage + ': Forgejo username/password form';
    await page.locator('#user_name').waitFor({ state: 'visible' });
    // Navigation can discard the prior document's response body in Chromium.
    // Inspect the outgoing request; only the explicit legacy-equivalent trial
    // reduces its scopes, leaving all normal login assertions unchanged.
    validateAuthorization(reducedAuthorizationURL || authorizationURL, scopes);
    await page.locator('#user_name').fill(credentials.name);
    await page.locator('#password').fill(credentials.password);
    stage = loginStage + ': Forgejo submit password';
    await page.locator('form').filter({ has: page.locator('#user_name') }).locator('button').click();
    if (expectConsent) {
      stage = loginStage + ': Forgejo consent form';
      await page.locator('#authorize-app').waitFor({ state: 'visible' });
      const consent = await page.locator('form[action$="/login/oauth/grant"] input[name="scope"]').inputValue();
      check(consent.split(' ').sort().join(' ') === scopes.slice().sort().join(' '), 'Consent scope mismatch');
      stage = loginStage + ': Forgejo consent redirect';
      await Promise.all([
        page.waitForURL(url => url.origin === golf && url.pathname === '/'),
        page.locator(approve ? '#authorize-app' : 'button[name="granted"][value="false"]').click(),
      ]);
    } else {
      // Pinned Forgejo reuses a confidential client's existing grant without
      // showing consent or expanding its scopes (oauth2_provider.go).
      check(approve, 'Existing-grant trial cannot deny absent consent');
      stage = loginStage + ': existing Forgejo grant redirect without consent';
      await page.waitForURL(url => url.origin === golf && url.pathname === '/');
    }
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
  async function revokeGrant(page, label) {
    stage = label + ': settings page';
    await page.goto(forge + '/user/settings/applications');
    stage = label + ': grant button';
    const grantButton = page.locator('button[data-url^="/user/settings/applications/oauth2/' + config.applicationID + '/revoke/"]');
    await grantButton.waitFor({ state: 'visible' });
    const revokePath = await grantButton.getAttribute('data-url');
    check(new RegExp('^/user/settings/applications/oauth2/' + config.applicationID + '/revoke/[0-9]+$').test(revokePath), 'Unexpected grant-revocation path');
    stage = label + ': open confirmation';
    await grantButton.click();
    stage = label + ': confirmation button';
    // Forgejo clones the confirmation template and removes its ID before showing it.
    const confirmGrant = page.locator('.ui.modal:visible').filter({ hasText: 'Revoke Access' }).locator('button.ok');
    await confirmGrant.waitFor({ state: 'visible' });
    stage = label + ': confirmation response';
    const [revoked] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === revokePath),
      confirmGrant.click(),
    ]);
    check(revoked.status() === 200, 'Forgejo did not revoke the user consent grant');
    stage = label + ': removed grant';
    await grantButton.waitFor({ state: 'hidden' });
    await page.goto('about:blank');
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
  check(available.forgeOauthEnabled === true && available.scopes.slice().sort().join(' ') === config.scopes.slice().sort().join(' '), 'Configured OAuth not available');
  stage = 'Alice browser login and consent';
  const aliceLogin = await login(alice, config.alice);
  stage = 'private repository and source through OAuth';
  const repository = { owner: config.alice.name, name: config.repository };
  const own = await rpc(alice, 'RepositoryService/GetRepository', { repository });
  check(own.repository.private && own.repository.fullName === config.alice.name + '/' + config.repository, 'Private repository mismatch');
  const source = await rpc(alice, 'RepositoryService/GetContents', { repository, ref: config.revision, path: config.path });
  check(source.commitId === config.revision && source.file.content === config.text, 'Private immutable source mismatch');
  const issues = await rpc(alice, 'RepositoryService/ListIssues', { repository });
  check((issues.issues ?? []).some(issue => issue.title === config.issueTitle), 'OAuth issue-read access did not work');
  stage = 'OAuth write:issue discussion';
  const reported = await rpc(alice, 'RepositoryService/CreateIssue', {
    repository, repositoryId: own.repository.id, title: 'OAuth authored issue',
    body: 'Created through the signed-in OAuth session.', idempotencyKey: crypto.randomUUID(),
  });
  check(reported.mutation.state === 'ISSUE_MUTATION_STATE_SUCCEEDED' && reported.issue.user.login === config.alice.name, 'OAuth issue creation did not return matching observed success');
  const replied = await rpc(alice, 'RepositoryService/CreateIssueComment', {
    repository, repositoryId: own.repository.id, number: reported.issue.number, issueId: reported.issue.id,
    body: 'Commented through the signed-in OAuth session.', idempotencyKey: crypto.randomUUID(),
  });
  check(replied.mutation.state === 'ISSUE_MUTATION_STATE_SUCCEEDED' && replied.comment.user.login === config.alice.name, 'OAuth comment creation did not return matching observed success');
  const discussion = await rpc(alice, 'RepositoryService/ListIssueComments', {
    repository, repositoryId: own.repository.id, number: reported.issue.number, issueId: reported.issue.id,
    page: { page: 1, limit: 100 },
  });
  check((discussion.comments ?? []).some(comment => comment.id === replied.comment.id), 'OAuth discussion read omitted its comment');
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
  console.log('PASS: actual Golf button, Forgejo login/consent, scoped private source/issues/create and six organization/team reads');
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
  const pending = validateAuthorization((await rpc(stranger, 'SessionService/BeginForgeOAuth')).authorizationUrl);
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
      console.log('STEP: waiting 16 seconds for real Forgejo access-token expiry');
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
  stage = 'legacy-equivalent narrower provider consent';
  const legacy = await browser.newContext(options);
  legacy.setDefaultTimeout(20000);
  legacy.setDefaultNavigationTimeout(20000);
  const oldScopes = config.scopes.filter(scope => scope !== 'read:organization').map(scope => scope === 'write:issue' ? 'read:issue' : scope);
  await login(legacy, config.legacyUser, true, oldScopes);
  const legacyCreated = await rpc(legacy, 'RepositoryService/CreateRepository', { name: 'legacy-issue-scope', private: true });
  const legacyIssueInput = { repository: { owner: config.legacyUser.name, name: 'legacy-issue-scope' },
    repositoryId: legacyCreated.repository.id, title: 'Legacy scope report', body: 'Requires explicit new consent.', idempotencyKey: crypto.randomUUID() };
  const legacyDenied = await rpc(legacy, 'RepositoryService/CreateIssue', legacyIssueInput);
  check(legacyDenied.mutation.state === 'ISSUE_MUTATION_STATE_REJECTED' && legacyDenied.mutation.failureCode === 'provider_http_403', 'Narrow read:issue grant wrote an issue');
  await rpc(legacy, 'RepositoryService/ListRepositories');
  await rpc(legacy, 'OrganizationService/ListOrganizations', {}, 403);
  await rpc(legacy, 'OrganizationService/GetOrganization', { organization: config.legacyOrganization }, 403);
  if (config.refresh) {
    stage = 'legacy-equivalent grant after rotating refresh';
    console.log('STEP: waiting 16 seconds to verify a narrower grant cannot expand on refresh');
    await new Promise(resolve => setTimeout(resolve, 16000));
    await rpc(legacy, 'SessionService/GetSession');
    await rpc(legacy, 'OrganizationService/ListOrganizations', {}, 403);
    await rpc(legacy, 'OrganizationService/GetOrganization', { organization: config.legacyOrganization }, 403);
  }
  stage = 'fresh sign-in with existing narrower grant';
  const reused = await browser.newContext(options);
  reused.setDefaultTimeout(20000);
  reused.setDefaultNavigationTimeout(20000);
  const reusedLogin = await login(reused, config.legacyUser, true, config.scopes, false);
  await rpc(reused, 'RepositoryService/ListRepositories');
  const reusedDenied = await rpc(reused, 'RepositoryService/CreateIssue', { ...legacyIssueInput, idempotencyKey: crypto.randomUUID() });
  check(reusedDenied.mutation.state === 'ISSUE_MUTATION_STATE_REJECTED' && reusedDenied.mutation.failureCode === 'provider_http_403', 'New login silently upgraded the old issue grant');
  await rpc(reused, 'OrganizationService/ListOrganizations', {}, 403);
  await rpc(reused, 'OrganizationService/GetOrganization', { organization: config.legacyOrganization }, 403);
  console.log('PASS: requesting expanded scopes on fresh login reuses the existing narrower grant without consent or broader access');
  await revokeGrant(reusedLogin.page, 'legacy grant revocation before expanded consent');
  await rpc(reused, 'SessionService/Logout');
  await reused.close();
  stage = 'explicit re-consent after user grant revocation';
  const renewed = await browser.newContext(options);
  renewed.setDefaultTimeout(20000);
  renewed.setDefaultNavigationTimeout(20000);
  await login(renewed, config.legacyUser);
  const renewedOrg = await rpc(renewed, 'OrganizationService/GetOrganization', { organization: config.legacyOrganization });
  check(renewedOrg.organization.name === config.legacyOrganization, 'Explicit re-consent did not enable own organization reads');
  const renewedIssue = await rpc(renewed, 'RepositoryService/CreateIssue', { ...legacyIssueInput, idempotencyKey: crypto.randomUUID() });
  check(renewedIssue.mutation.state === 'ISSUE_MUTATION_STATE_SUCCEEDED' && renewedIssue.issue.user.login === config.legacyUser.name, 'Explicit re-consent did not enable write:issue');
  const retainedDenial = await rpc(renewed, 'RepositoryService/CreateIssue', legacyIssueInput);
  check(JSON.stringify(retainedDenial.mutation) === JSON.stringify(legacyDenied.mutation), 'Broader consent redispatched an old rejected intent');
  await rpc(legacy, 'SessionService/Logout');
  await rpc(renewed, 'SessionService/Logout');
  await legacy.close(); await renewed.close();
  console.log('PASS: real narrower consent stays limited through refresh and new login; explicit user grant revocation and fresh consent enable organization reads/issue writes without replaying old intents');
  await revokeGrant(aliceLogin.page, 'Forgejo user consent revocation');
  if (config.refresh) {
    console.log('STEP: waiting 16 seconds to test expiry after user consent revocation');
    await new Promise(resolve => setTimeout(resolve, 16000));
  }
  await rpc(alice, 'SessionService/GetSession', {}, 401, 'unauthenticated');
  await rpc(alice, 'RepositoryService/GetContents', { repository, ref: config.revision, path: config.path }, 401, 'unauthenticated');
  check((await rpc(bobAllowed, 'SessionService/GetSession')).user.login === config.bob.name, 'Revoking Alice affected another user grant');
  console.log('PASS: actual Forgejo user consent revocation denies Alice while Bob remains authorized');
  stage = 'configured application deletion';
  const removed = await stranger.request.delete(forge + '/api/v1/user/applications/oauth2/' + config.applicationID,
    { headers: { Authorization: config.ownerAuthorization } });
  check(removed.status() === 204, 'Could not revoke temporary OAuth application');
  if (config.refresh) {
    console.log('STEP: waiting 16 seconds to test expiry after configured client deletion');
    await new Promise(resolve => setTimeout(resolve, 16000));
  }
  // Forgejo reports invalid_client at refresh after application deletion: this
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
    # Read only these two non-secret settings. Forgejo's env-to-ini startup writes
    # them persistently; restoring just the container environment is insufficient.
    script = r'''awk '
      /^\[/ { section=tolower($0); gsub(/[[:space:]\r]/,"",section) }
      section=="[oauth2]" && /=/ {
        key=$0; sub(/=.*/,"",key); gsub(/[[:space:]]/,"",key); key=toupper(key)
        if (key=="ACCESS_TOKEN_EXPIRATION_TIME" || key=="INVALIDATE_REFRESH_TOKENS") {
          value=$0; sub(/^[^=]*=/,"",value); sub(/[;#].*$/, "",value); gsub(/[[:space:]\r]/,"",value)
          print key "=" value
        }
      }' /var/lib/gitea/custom/conf/app.ini'''  # Forgejo's upstream path
    output = compose(None, 'exec', '-T', 'forgejo', 'sh', '-c', script)
    # Pinned Forgejo 15.0.9 defaults: modules/setting/oauth2.go.
    settings = {'ACCESS_TOKEN_EXPIRATION_TIME': '3600', 'INVALIDATE_REFRESH_TOKENS': 'true'}
    for line in output.splitlines():
        key, value = line.split('=', 1)
        settings[key] = value.strip('"').lower()
    if not settings['ACCESS_TOKEN_EXPIRATION_TIME'].isdigit() or settings['INVALIDATE_REFRESH_TOKENS'] not in ('true', 'false'):
        raise RuntimeError('Cannot safely determine original Provider OAuth settings')
    return {'FORGEJO__oauth2__' + key: value for key, value in settings.items()}


def delete_application(user, app_id):
    try:
        request(client(), 'DELETE', FORGE + '/api/v1/user/applications/oauth2/' + str(app_id),
                headers={'Authorization': basic(user)}, expected=204)
    except AssertionError as error:
        # The successful browser check already revoked the application.
        if ': 404, expected 204' not in str(error):
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='also restart Forgejo and qualify two real 15-second rotating-refresh cycles')
    args = parser.parse_args()
    ready()
    if rpc(client(), 'SessionService/GetAuthenticationOptions').get('forgeOauthEnabled', False):
        raise RuntimeError('This disposable smoke requires Golf OAuth to be disabled initially')
    if request(client(), 'GET', FORGE + '/api/v1/version')['version'] != '15.0.9+gitea-1.22.0':  # Forgejo's upstream version string
        raise RuntimeError('This smoke qualifies only the pinned Forgejo 15.0.9')
    if not (ROOT / 'web/node_modules/playwright/index.mjs').is_file():
        raise RuntimeError('Install web dependencies and Playwright Chromium before this smoke')
    original_settings = original_refresh_settings() if args.refresh else None
    users, app, changed = [], None, False
    organization = None
    legacy_organization = None
    suffix = secrets.token_hex(4)
    with tempfile.TemporaryDirectory(prefix='golf-oauth-smoke-', dir='/tmp') as directory:
        path = Path(directory)
        os.chmod(path, 0o700)
        try:
            for label in ('owner', 'alice', 'bob', 'session-control', 'legacy'):
                name = 'golf-oauth-' + label + '-' + suffix
                output = admin('create', '--username', name, '--email', name + '@example.invalid',
                               '--random-password', '--random-password-length', '32', '--must-change-password=false')
                user = {'name': name}
                users.append(user)
                match = re.search(r"^generated random password is '(.*)'$", output, re.MULTILINE)
                if not match:
                    raise RuntimeError('Could not capture generated test-user password')
                user['password'] = match.group(1)
            owner, alice, bob, session_user, legacy_user = users
            app = request(client(), 'POST', FORGE + '/api/v1/user/applications/oauth2',
                          {'name': 'Golf OAuth smoke ' + suffix, 'redirect_uris': [GOLF + '/auth/forgejo/callback'],
                           'confidential_client': True, 'skip_secondary_authorization': False},
                          headers={'Authorization': basic(owner)}, expected=201)
            if not app.get('client_id') or not app.get('client_secret') or not app.get('confidential_client'):
                raise RuntimeError('Forgejo did not register the confidential test application')
            organization_name = 'golf-oauth-org-' + suffix
            request(client(), 'POST', FORGE + '/api/v1/orgs',
                    {'username': organization_name, 'visibility': 'private'},
                    headers={'Authorization': basic(alice)}, expected=201)
            organization = organization_name
            legacy_name = 'golf-oauth-legacy-org-' + suffix
            request(client(), 'POST', FORGE + '/api/v1/orgs',
                    {'username': legacy_name, 'visibility': 'private'},
                    headers={'Authorization': basic(legacy_user)}, expected=201)
            legacy_organization = legacy_name
            repository = 'oauth-private'
            request(client(), 'POST', FORGE + '/api/v1/user/repos',
                    {'name': repository, 'private': True, 'auto_init': True, 'readme': 'Default', 'default_branch': 'main'},
                    headers={'Authorization': basic(alice)}, expected=201)
            source_path, text = 'nested space/source.txt', 'Private source from real Provider OAuth.\n'
            source = request(client(), 'POST', FORGE + '/api/v1/repos/' + alice['name'] + '/' + repository + '/contents/' + urllib.parse.quote(source_path),
                             {'content': base64.b64encode(text.encode()).decode(), 'message': 'OAuth smoke source', 'branch': 'main'},
                             headers={'Authorization': basic(alice)}, expected=201)
            issue_title = 'OAuth scoped issue'
            request(client(), 'POST', FORGE + '/api/v1/repos/' + alice['name'] + '/' + repository + '/issues',
                    {'title': issue_title}, headers={'Authorization': basic(alice)}, expected=201)
            services = {'golf': {'environment': {'GOLF_FORGE_PUBLIC_URL': FORGE, 'GOLF_FORGE_OAUTH_CLIENT_ID': app['client_id'], 'GOLF_FORGE_OAUTH_CLIENT_SECRET': app['client_secret']}}}
            if args.refresh:
                services['forgejo'] = {'environment': {'FORGEJO__oauth2__ACCESS_TOKEN_EXPIRATION_TIME': '15', 'FORGEJO__oauth2__INVALIDATE_REFRESH_TOKENS': 'true'}}
            override = path / 'oauth.compose.json'
            private_json(override, {'services': services})
            changed = True
            print('STEP: enabling disposable OAuth configuration' + (' and 15-second access tokens' if args.refresh else ''), flush=True)
            compose(override, 'up', '-d', '--no-deps', '--force-recreate', *(['forgejo', 'golf'] if args.refresh else ['golf']))
            ready()
            if args.refresh and original_refresh_settings() != services['forgejo']['environment']:
                raise RuntimeError('Forgejo did not apply the requested short lifetime and refresh rotation settings')
            browser_script = path / 'check.mjs'
            browser_script.write_text(BROWSER_CHECK)
            browser_script.chmod(0o600)
            config = {'golf': GOLF, 'forge': FORGE, 'alice': alice, 'bob': bob, 'sessionUser': session_user,
                      'legacyUser': legacy_user, 'legacyOrganization': legacy_organization,
                      'ownerAuthorization': basic(owner), 'clientID': app['client_id'], 'applicationID': app['id'],
                      'scopes': ['write:user', 'write:repository', 'write:issue', 'read:organization', 'write:notification'], 'repository': repository,
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
                        private_json(restore, {'services': {'forgejo': {'environment': original_settings}}})
                        compose(restore, 'up', '-d', '--no-deps', '--force-recreate', 'forgejo')
                    compose(None, 'up', '-d', '--no-deps', '--force-recreate', *(['forgejo', 'golf'] if args.refresh else ['golf']))
                    ready()
                    if rpc(client(), 'SessionService/GetAuthenticationOptions').get('forgeOauthEnabled', False):
                        raise RuntimeError('Golf OAuth remained enabled after restoration')
                    if original_settings is not None and original_refresh_settings() != original_settings:
                        raise RuntimeError('Provider OAuth timing settings were not restored')
                except Exception:
                    cleanup_errors.append('service configuration restoration failed; inspect local Compose state')
            if organization and len(users) > 1:
                try:
                    request(client(), 'DELETE', FORGE + '/api/v1/orgs/' + organization,
                            headers={'Authorization': basic(users[1])}, expected=204)
                except Exception:
                    cleanup_errors.append('temporary OAuth organization deletion failed')
            if legacy_organization and len(users) > 4:
                try:
                    request(client(), 'DELETE', FORGE + '/api/v1/orgs/' + legacy_organization,
                            headers={'Authorization': basic(users[4])}, expected=204)
                except Exception:
                    cleanup_errors.append('temporary legacy OAuth organization deletion failed')
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
            print('Temporary OAuth application/users/repos removed; OAuth disabled and original Forgejo settings restored.', flush=True)


if __name__ == '__main__':
    main()
