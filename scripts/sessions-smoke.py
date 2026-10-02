#!/usr/bin/env python3
"""Verify per-user session listing/revocation against the actual Compose stack.

Uses disposable Gitea users and scoped PATs through supported CLI/API operations.
No database or .env edits; no credentials or cookie values are printed. Requires
the current built Golf image. Provider consent/tokens are distinct from Golf
sessions. The broader OAuth smoke separately qualifies the OAuth credential path.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import re
import secrets
import subprocess
import sys

sys.dont_write_bytecode = True
from smoke import GITEA, GOLF, ROOT, admin, client, ready, request, rpc


BROWSER_CHECK = r'''
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
let browser, stage = 'browser dependencies';
class CheckFailure extends Error {}
function check(value, message) { if (!value) throw new CheckFailure(message); }
try {
  const { chromium } = await import(pathToFileURL(join(process.cwd(), 'web/node_modules/playwright/index.mjs')));
  let input = '';
  for await (const part of process.stdin) input += part;
  const config = JSON.parse(input); input = '';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const other = await browser.newContext();
  const headers = { Origin: config.golf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' };
  async function call(client, procedure, data = {}, status = 200) {
    const response = await client.request.post(config.golf + '/rpc/golf.v1.SessionService/' + procedure, { headers, data });
    check(response.status() === status, 'Session procedure returned unexpected HTTP status');
    check(response.headers()['cache-control'] === 'no-store', 'Session response caching is enabled');
    return response.json();
  }
  stage = 'second real session';
  await call(other, 'LoginWithGiteaToken', { token: config.token });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', () => errors.push('runtime error'));
  stage = 'actual token sign-in form';
  await page.goto(config.golf);
  await page.getByText('Advanced token sign-in', { exact: true }).click();
  await page.getByLabel('Provider access token', { exact: true }).fill(config.token);
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'Sessions', exact: true }).waitFor();
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  stage = 'sessions page and metadata';
  await page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'Sessions', exact: true }).click();
  const dialog = page.getByRole('region', { name: 'Your Golf sessions', exact: true });
  await dialog.locator('table[aria-label="Sessions"] tbody tr[data-row-id]').nth(1).waitFor();
  const listing = await call(context, 'ListSessions');
  check(listing.sessions.length === 2 && listing.sessions.filter(row => row.current).length === 1, 'Real session list mismatch');
  for (const row of listing.sessions) check((await dialog.innerText()).includes(row.id), 'Table omitted a real session');
  check((await dialog.innerText()).includes('does not revoke'), 'Provider/session boundary missing');
  await page.screenshot({ path: join(config.screenshots, 'sessions-dark.png') });
  stage = 'light and mobile sessions page';
  await page.getByRole('navigation', {name:'Account settings',exact:true}).getByRole('link', {name:'Profile',exact:true}).click();
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', {name:'Workspace',exact:true}).getByRole('link', { name: 'Sessions', exact: true }).click();
  await dialog.locator('table[aria-label="Sessions"] tbody tr[data-row-id]').nth(1).waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page overflows');
  await page.screenshot({ path: join(config.screenshots, 'sessions-light-mobile.png') });
  stage = 'cancel and confirm other-session revocation';
  await dialog.getByRole('button', { name: 'Revoke all other sessions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await call(other, 'GetSession');
  await dialog.getByRole('button', { name: 'Revoke all other sessions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm revoke other sessions', exact: true }).click();
  await dialog.getByText('1 other session revoked.', { exact: true }).waitFor();
  await call(other, 'GetSession', {}, 401);
  await dialog.getByRole('button', { name: 'Revoke current session', exact: true }).waitFor();
  stage = 'current-session revocation and private UI removal';
  await dialog.getByRole('button', { name: 'Revoke current session', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm revoke session', exact: true }).click();
  await page.getByText('Advanced token sign-in', { exact: true }).waitFor();
  check(await page.locator('table[aria-label="Sessions"] tbody tr[data-row-id]').count() === 0, 'Private session rows survived sign-out');
  await call(context, 'GetSession', {}, 401);
  check(!(await context.cookies(config.golf)).some(cookie => cookie.name === 'golf_session'), 'Current session cookie survived revocation');
  check(errors.length === 0, 'Browser runtime error');
  console.log('PASS: production-served sessions page, real metadata, dark/light/mobile, cancel/confirm and revoked-session UI cleanup');
} catch (error) {
  console.error('FAIL: ' + stage + (error instanceof CheckFailure ? ': ' + error.message : ' (diagnostics withheld)'));
  process.exitCode = 1;
} finally { await browser?.close(); }
'''


def browser_check(token):
    screenshots = ROOT / '.tmp/session-smoke'
    screenshots.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = subprocess.run(['node', '--input-type=module', '-e', BROWSER_CHECK],
                            input=json.dumps({'golf': GOLF, 'token': token, 'screenshots': str(screenshots)}), cwd=ROOT,
                            capture_output=True, text=True, timeout=120)
    for line in result.stdout.splitlines():
        if line.startswith('PASS:'):
            print(line, flush=True)
    if result.returncode:
        safe = next((line for line in result.stderr.splitlines() if line.startswith('FAIL:')), 'FAIL: browser check (diagnostics withheld)')
        raise RuntimeError(safe)


def sessions(opener, limit=2):
    rows, page = [], 1
    while page:
        result = rpc(opener, 'SessionService/ListSessions', {'page': {'page': page, 'limit': limit}})
        batch = result.get('sessions', [])
        assert len(batch) <= limit
        for row in batch:
            assert set(row) <= {'id', 'createdAt', 'expiresAt', 'current', 'credentialKind'}
            assert row['id'].isdigit() and int(row['id']) > 0
            assert row['credentialKind'] in ('pat', 'oauth')
            assert datetime.fromisoformat(row['expiresAt'].replace('Z', '+00:00')) > datetime.fromisoformat(row['createdAt'].replace('Z', '+00:00'))
        rows.extend(batch)
        page = result.get('page', {}).get('nextPage', 0)
        assert not page or page <= 10_000
    assert len({row['id'] for row in rows}) == len(rows)
    assert sum(bool(row.get('current')) for row in rows) == 1
    return rows


def cookie_value(opener):
    for handler in opener.handlers:
        if hasattr(handler, 'cookiejar'):
            return next(cookie.value for cookie in handler.cookiejar if cookie.name == 'golf_session')
    raise AssertionError('No session cookie')


def main():
    ready()
    users = []
    try:
        identities = {}
        for label in ('alice', 'bob'):
            name = 'golf-sessions-' + label + '-' + secrets.token_hex(4)
            output = admin('create', '--username', name, '--email', name + '@example.invalid',
                           '--random-password', '--random-password-length', '32', '--must-change-password=false')
            users.append(name)
            match = re.search(r"^generated random password is '(.*)'$", output, re.MULTILINE)
            assert match, 'Could not capture disposable generated password'
            token = admin('generate-access-token', '--username', name, '--token-name', 'session-lifecycle',
                          '--scopes', 'read:user,read:repository,read:issue', '--raw')
            identities[label] = {'name': name, 'password': match.group(1), 'token': token}

        def login(label):
            opener = client()
            assert rpc(opener, 'SessionService/LoginWithGiteaToken', {'token': identities[label]['token']})['user']['login'] == identities[label]['name']
            return opener

        alice = [login('alice') for _ in range(5)]
        bob = login('bob')
        initial = sessions(alice[0])
        assert len(initial) == 5
        for secret in [identities['alice']['token'], cookie_value(alice[0])]:
            assert secret not in json.dumps(initial)
        bob_rows = sessions(bob)
        assert len(bob_rows) == 1 and not {row['id'] for row in initial}.intersection(row['id'] for row in bob_rows)
        rpc(client(), 'SessionService/ListSessions', expected=401)
        rpc(alice[0], 'SessionService/ListSessions', headers={'Origin': 'https://wrong.example.invalid'}, expected=403)
        rpc(alice[0], 'SessionService/ListSessions', {'page': {'limit': 101}}, expected=400)
        for session_id in ('', '0', '-1', '01', '1.0', '9223372036854775808', cookie_value(alice[0])):
            rpc(alice[0], 'SessionService/RevokeSession', {'sessionId': session_id}, expected=400)
        for target in (bob_rows[0]['id'], '9223372036854775807'):
            rpc(alice[0], 'SessionService/RevokeSession', {'sessionId': target}, expected=404)
        assert rpc(bob, 'SessionService/GetSession')['user']['login'] == identities['bob']['name']
        target = next(row['id'] for row in sessions(alice[1]) if row.get('current'))
        assert not rpc(alice[0], 'SessionService/RevokeSession', {'sessionId': target}).get('currentSessionRevoked', False)
        rpc(alice[1], 'SessionService/GetSession', expected=401)
        rpc(alice[0], 'SessionService/RevokeSession', {'sessionId': target}, expected=404)
        assert len(sessions(alice[0])) == 4
        print('PASS: paginated private session metadata, input/origin checks, cross-user denial and individual revocation', flush=True)

        result = rpc(alice[0], 'SessionService/RevokeOtherSessions')
        assert result.get('revokedCount') == '3'
        assert len(sessions(alice[0])) == 1
        for opener in alice[1:]:
            rpc(opener, 'SessionService/GetSession', expected=401)
            rpc(opener, 'SessionService/RevokeOtherSessions', expected=401)
        assert rpc(alice[0], 'SessionService/RevokeOtherSessions').get('revokedCount', '0') == '0'
        assert rpc(bob, 'SessionService/GetSession')['user']['login'] == identities['bob']['name']
        print('PASS: revoke-other preserves current/other-user sessions and rejects deleted-session replay', flush=True)

        # Two active callers race to revoke the others. Exactly one may survive;
        # the loser must recheck its own deletion rather than resurrect a session.
        contender = login('alice')
        def bulk(opener):
            try:
                return rpc(opener, 'SessionService/RevokeOtherSessions')
            except AssertionError:
                rpc(opener, 'SessionService/GetSession', expected=401)
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(bulk, [alice[0], contender]))
        assert sum(value is not None for value in outcomes) == 1
        survivor = alice[0] if outcomes[0] is not None else contender
        assert len(sessions(survivor)) == 1
        current = next(row['id'] for row in sessions(survivor) if row.get('current'))
        previous_cookie = cookie_value(survivor)
        assert rpc(survivor, 'SessionService/RevokeSession', {'sessionId': current})['currentSessionRevoked'] is True
        rpc(survivor, 'SessionService/GetSession', expected=401)
        rpc(client(), 'SessionService/GetSession', headers={'Cookie': 'golf_session=' + previous_cookie}, expected=401)
        print('PASS: concurrent revoke-other serialization and current-session revocation deny cookie replay', flush=True)

        browser_check(identities['alice']['token'])

        # Golf-session revocation does not claim to revoke the upstream PAT.
        recovered = login('alice')
        assert len(sessions(recovered)) == 1
        basic = base64.b64encode((identities['alice']['name'] + ':' + identities['alice']['password']).encode()).decode()
        token_url = GITEA + '/api/v1/users/' + identities['alice']['name'] + '/tokens'
        tokens = request(client(), 'GET', token_url, headers={'Authorization': 'Basic ' + basic})
        token_id = next(item['id'] for item in tokens if item['name'] == 'session-lifecycle')
        request(client(), 'DELETE', token_url + '/' + str(token_id), headers={'Authorization': 'Basic ' + basic}, expected=204)
        for procedure, body in [('ListSessions', {}), ('RevokeSession', {'sessionId': bob_rows[0]['id']}), ('RevokeOtherSessions', {})]:
            rpc(recovered, 'SessionService/' + procedure, body, expected=401)
        rpc(recovered, 'SessionService/Logout')
        assert len(sessions(bob)) == 1
        rpc(bob, 'SessionService/Logout')
        print('PASS: revoked upstream credentials cannot list or mutate sessions; unrelated user remains authorized', flush=True)
    finally:
        failed = []
        for name in users:
            try:
                admin('delete', '--username', name, '--purge')
            except RuntimeError:
                failed.append(name)
        if failed:
            raise RuntimeError('Could not purge disposable session test users')
        print('Disposable session users and provider credentials removed.', flush=True)


if __name__ == '__main__':
    main()
