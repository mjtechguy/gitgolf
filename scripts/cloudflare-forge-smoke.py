#!/usr/bin/env python3
"""Bounded native Artifacts/D1/DO repository proof; removes only its owned resources."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from cloudflare_setup import replace_private_json

ROOT = Path(__file__).resolve().parents[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class DemoFinished(Exception):
    pass


def await_session(read):
    for attempt in range(180):
        try:
            session = read()
        except (RuntimeError, urllib.error.URLError, TimeoutError):
            if attempt == 179:
                raise
            time.sleep(1)
            continue
        if session.get('user', {}).get('id') != '1':
            raise RuntimeError('Unexpected native actor')
        return session


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--workers-subdomain', required=True)
    parser.add_argument('--evidence', action='store_true', help='Qualify native Queues/Workflows/R2 PR evidence')
    parser.add_argument('--evidence-ai', action='store_true', help='Add one real Clef call through a private AI Gateway')
    parser.add_argument('--container-tests', action='store_true', help='Execute exact native PR head tests in a real container')
    parser.add_argument('--ci-resilience', action='store_true', help='With container tests: concurrent replay, allocation cap, admitted cancellation and cross-repository denial')
    parser.add_argument('--agents', action='store_true', help='Execute two native-authorized concurrent PR agents in separate private forks')
    parser.add_argument('--delivery', action='store_true', help='Qualify automatic static delivery, real preview service RPC and one Browser Run snapshot; human Access login remains separate')
    parser.add_argument('--apps', action='store_true', help='Qualify isolated managed Worker apps and Secrets Store; requires --delivery and an owned preview zone/hostname')
    parser.add_argument('--app-zone')
    parser.add_argument('--app-host')
    parser.add_argument('--demo-host', help='Prepare a four-hour human Access demo after successful seeding; use cloudflare_demo.py to begin or stop it')
    parser.add_argument('--demo-email', help='Existing Access seat to map to the native demo owner')
    parser.add_argument('--unattended', action='store_true', help='Service-auth only; run all checks then tear down within 45 minutes, without email or login')
    parser.add_argument('--operations-rehearsal', action='store_true', help='Qualify guarded release/rollback and read-only Operations collectors in the disposable demo')
    parser.add_argument('--registry-host', help='Fresh dedicated CFCR hostname in the selected app zone; requires --apps')
    parser.add_argument('--registry-scanner-image', help='Approved local CFCR scanner image; requires --registry-host')
    args = parser.parse_args()
    if args.registry_host and (not args.apps or not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+', args.registry_host) or args.registry_host in [args.app_host, args.demo_host]):
        parser.error('--registry-host requires --apps and a distinct canonical hostname')
    if args.registry_scanner_image and not args.registry_host:
        parser.error('--registry-scanner-image requires --registry-host')
    if args.evidence_ai and not args.evidence:
        parser.error('--evidence-ai requires --evidence')
    if args.container_tests and not args.evidence:
        parser.error('--container-tests requires --evidence')
    if args.ci_resilience and (not args.container_tests or args.agents or args.demo_host):
        parser.error('--ci-resilience requires --container-tests and a standalone non-agent proof')
    if args.agents and not (args.container_tests and args.evidence_ai):
        parser.error('--agents requires --container-tests and --evidence-ai')
    if args.delivery and not args.container_tests:
        parser.error('--delivery requires --container-tests')
    if args.apps and (not args.delivery or not re.fullmatch('[a-f0-9]{32}', args.app_zone or '') or not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+', args.app_host or '')):
        parser.error('--apps requires --delivery, canonical --app-zone and --app-host')
    demo = bool(args.demo_host or args.demo_email)
    evidence_limit = 8 if demo else 4 if args.agents else 3 if args.ci_resilience or args.registry_scanner_image else 2
    if args.unattended and (not args.demo_host or args.demo_email):
        parser.error('--unattended requires --demo-host and forbids --demo-email')
    if args.operations_rehearsal and not demo:
        parser.error('--operations-rehearsal requires an explicitly owned demo')
    if demo and (not args.apps or not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+', args.demo_host or '') or (not args.unattended and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', args.demo_email or '')) or args.demo_host == args.app_host):
        parser.error('Demo requires --apps, a separate canonical --demo-host, and either --demo-email or --unattended')
    if not re.fullmatch('[a-f0-9]{32}', args.account_id) or not re.fullmatch('[a-zA-Z0-9_-]{1,63}', args.profile):
        parser.error('Canonical account and named profile required')
    if not re.fullmatch('[a-z0-9-]{1,63}', args.workers_subdomain):
        parser.error('Canonical Workers subdomain required')
    if any(os.environ.get(k) for k in ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY']):
        parser.error('Remove ambient Cloudflare credential overrides')
    name = 'golf-native-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d') + '-' + secrets.token_hex(4)
    directory = ROOT / '.tmp/cloudflare-forge' / name
    directory.mkdir(mode=0o700, parents=True)
    state = {'schema': 'golf.cloudflare.native-repositories.v1', 'name': name, 'account': args.account_id,
             'profile': args.profile, 'state': 'running', 'resources': {}, 'events': [], 'checks': {}, 'cleanup': {}}
    if demo:
        state['demo_process'] = {'pid': os.getpid(), 'start_ticks': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]}
    if args.evidence:
        state['schema'] = 'golf.cloudflare.native-evidence.v1'
    state['source_sha256'] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [
        Path(__file__).resolve(), ROOT/'scripts/cloudflare_hosted_check.py', ROOT/'scripts/fixtures/registry_publish.py', ROOT/'scripts/cloudflare_registry_check.py', ROOT/'scripts/cloudflare_rehearsal.py', ROOT/'scripts/cloudflare_demo.py', ROOT/'cloudflare/forge/schema.sql', ROOT/'cloudflare/forge/prepare.mjs', ROOT/'internal/cli/cli.go', ROOT/'internal/cli/writes.go', ROOT/'cmd/golfctl/main.go', ROOT/'go.mod', ROOT/'go.sum',
        *sorted((ROOT/'cloudflare/forge/src').glob('*.mjs'))]}
    if args.container_tests:
        state['source_sha256']['cloudflare/agents/Dockerfile'] = hashlib.sha256((ROOT/'cloudflare/agents/Dockerfile').read_bytes()).hexdigest()
        state['source_sha256']['cloudflare/agents/package-lock.json'] = hashlib.sha256((ROOT/'cloudflare/agents/package-lock.json').read_bytes()).hexdigest()
    if args.agents:
        for p in sorted((ROOT/'cloudflare/agents/src').glob('*.mjs')):
            state['source_sha256'][str(p.relative_to(ROOT))] = hashlib.sha256(p.read_bytes()).hexdigest()
    environment = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': args.account_id, 'CF_SEND_TELEMETRY': 'false', 'CI': 'true'}
    owner = 'golf_native_' + secrets.token_urlsafe(32)
    reader = 'golf_native_' + secrets.token_urlsafe(32)
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    url = ''
    machine = None
    management = None
    analytics = None
    registry = None
    signing_key = secrets.token_urlsafe(32) if args.apps else None
    redactions = [owner, reader]
    if args.delivery:
        state['source_sha256']['cloudflare/forge/prepare-proof.mjs'] = hashlib.sha256((ROOT/'cloudflare/forge/prepare-proof.mjs').read_bytes()).hexdigest()

    def save():
        replace_private_json(directory/'ownership.json', state)

    def command(label, argv, *, cwd=ROOT, env=environment, required=True, timeout=60):
        state['events'].append({'operation': label, 'state': 'dispatched'})
        save()
        with subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except BaseException:
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                from cloudflare_setup import stop_owned_image_uploads
                tags = [state['resources'][key]['tag'] for key in ['test_image', 'registry_image'] if key in state['resources']]
                stop_owned_image_uploads(args.account_id, tags)
                try: process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.stdout.close(); process.stderr.close()
                raise
        state['events'][-1].update(state='returned', exit_code=process.returncode)
        save()
        if required and process.returncode:
            # Keep provider diagnostics owner-only, and redact all credential forms.
            diagnostic = stderr.decode(errors='replace')
            for value in redactions:
                diagnostic = diagnostic.replace(value, '[private]')
            diagnostic = re.sub(r'art_v1_[^\s\"\']+', '[provider credential]', diagnostic)
            log = directory / 'failure.txt'
            log.write_text(diagnostic)
            log.chmod(0o600)
            raise RuntimeError(label + ' failed')
        return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)

    def cf(label, *arguments, required=True):
        result = command(label, ['cf', '--profile', args.profile, *map(str, arguments)], required=required)
        return json.loads(result.stdout) if not result.returncode and result.stdout.strip() else None

    def query(sql, params=None):
        return cf('owned database query', 'd1', 'query', state['resources']['database']['uuid'],
                  '--body', json.dumps({'sql': sql, 'params': params or []}))

    def provider(path, method='GET', body=None, expected=200, token=None):
        # Newly minted selected-account authority only; never extract CLI OAuth credentials.
        if not path.startswith('/') or any(c in path for c in ['?', '#', '\\']):
            raise RuntimeError('Invalid qualification provider path')
        state['events'].append({'operation': 'provider ' + method + ' ' + path, 'state': 'dispatched'})
        save()
        request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path,
            data=None if body is None else json.dumps(body).encode(), method=method,
            headers={'Authorization': 'Bearer ' + (token or management['value']), 'Content-Type': 'application/json', 'User-Agent': 'GolfNativeForgeQualification/1'})
        try:
            response = client.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(262145)
            state['events'][-1].update(state='returned', status=response.status)
            save()
            if len(data) > 262144 or response.status not in (expected if isinstance(expected, tuple) else (expected,)):
                raise RuntimeError('Provider qualification result unconfirmed: ' + str(response.status))
            if response.status == 404:
                return None
            if method == 'DELETE' and not data and 200 <= response.status < 300:
                return None
            value = json.loads(data)
            if value.get('success') is not True:
                raise RuntimeError('Provider qualification result refused')
            if method == 'GET' and re.fullmatch(r'/accounts/[a-f0-9]{32}/workers/dispatch/namespaces/[^/]+/scripts/[^/]+', path) and value.get('result', {}).get('script') is None:
                return None
            return value['result']

    def http(path, payload=None, token=owner, expected=200, routing_attempt=0, method='POST', raw=False):
        headers = {'User-Agent': 'GolfNativeForgeQualification/1'}
        if method != 'GET': headers.update({'Content-Type': 'application/json', 'Connect-Protocol-Version': '1'})
        if demo and settings.get('access_aud'):
            headers.update({'CF-Access-Client-Id': machine['client_id'], 'CF-Access-Client-Secret': machine['client_secret']})
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(url + path, data=None if method == 'GET' else json.dumps(payload or {}).encode(), headers=headers, method=method)
        try:
            response = client.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            asset = method == 'GET' and re.fullmatch(r'/assets/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|svg)', path)
            maximum = 4 * 1024 * 1024 if asset else 262144
            data = response.read(maximum + 1)
            if len(data) > maximum:
                raise RuntimeError('HTTP response exceeds proof bound')
            if data in [b'error code: 1042\n', b'error code: 1104\n'] and routing_attempt < 10 and (method == 'GET' or path.rsplit('/', 1)[-1] in ['GetSession', 'CreateRepository', 'GetRepository', 'GetContents', 'ListBranches', 'ResolveRepositorySource', 'GetIssue', 'ListIssues', 'GetPullRequest', 'GetPullRequestDiscussion', 'ListIssueComments', 'ListPullRequestReviews', 'ListPullRequestChecks', 'GetIssueMutation', 'GetPullRequestReviewMutation'] or bool((payload or {}).get('idempotencyKey'))):
                time.sleep(1)
                return http(path, payload, token, expected, routing_attempt + 1, method, raw)
            if response.status not in (expected if isinstance(expected, tuple) else (expected,)):
                state['checks']['last_http_failure'] = {'status': response.status, 'path': path, 'action': (payload or {}).get('action'), 'kind': (payload or {}).get('kind'),
                    'body': data.decode(errors='replace').replace(owner, '[private]').replace(reader, '[private]')[:2000]}
                save()
                raise RuntimeError('Native HTTP result differed')
            policy = response.headers.get('Cache-Control') or ''
            if ('private' not in policy or 'immutable' not in policy) if asset else 'no-store' not in policy:
                raise RuntimeError('Private response cache policy missing')
            if owner.encode() in data or reader.encode() in data or b'art_v1_' in data:
                raise RuntimeError('Credential disclosure')
            value = data if raw else json.loads(data)
            if path == '/native/diagnostics' and response.status == 200:
                from cloudflare_rehearsal import require_converged_diagnostics
                require_converged_diagnostics(value, response.headers.get('X-Golf-Worker-Release'), response.headers.get('X-Golf-Worker-Configuration'))
            return value

    def rpc(method, payload=None, **options):
        return http('/rpc/golf.v1.RepositoryService/' + method, payload, **options)

    def preview_rpc(payload, expected=200, access=True):
        headers = {'User-Agent': 'GolfNativeForgeQualification/1', 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + owner}
        if access:
            headers.update({'CF-Access-Client-Id': machine['client_id'], 'CF-Access-Client-Secret': machine['client_secret']})
        request = urllib.request.Request(settings['previews']['origin'] + '/__qualification', data=json.dumps(payload).encode(), headers=headers)
        try:
            response = client.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            if response.status not in (expected if isinstance(expected, tuple) else (expected,)):
                state['checks']['last_preview_failure'] = {'status': response.status, 'expected': expected, 'access': access, 'content_type': response.headers.get('Content-Type'), 'location_host': urllib.parse.urlparse(response.headers.get('Location') or '').hostname}
                save()
                raise RuntimeError('Preview service RPC or Access boundary differed')
            return json.loads(response.read(262144)) if response.status == 200 else None

    def git(label, *arguments, token=owner, required=True):
        env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
               'GIT_CONFIG_SYSTEM': os.devnull, 'GIT_TERMINAL_PROMPT': '0', 'GIT_TRACE_PACKET': '1'}
        config = {'credential.helper': '', 'core.hooksPath': os.devnull, 'http.followRedirects': 'false', 'http.proxy': '',
                  'http.sslVerify': 'true', 'user.name': 'Golf native qualification', 'user.email': 'native@example.invalid'}
        if token:
            config['http.extraHeader'] = 'Authorization: Bearer ' + token
        config = list(config.items())
        if demo and settings.get('access_aud'):
            config.extend([('http.extraHeader', 'CF-Access-Client-Id: ' + machine['client_id']), ('http.extraHeader', 'CF-Access-Client-Secret: ' + machine['client_secret'])])
        env['GIT_CONFIG_COUNT'] = str(len(config))
        for i, (key, value) in enumerate(config):
            env[f'GIT_CONFIG_KEY_{i}'], env[f'GIT_CONFIG_VALUE_{i}'] = key, value
        return command(label, ['git', *map(str, arguments)], env=env, required=required)

    def interrupt(*_):
        if demo and state['state'] in ['awaiting_login', 'ready']:
            raise DemoFinished('Demo stopped by signal or deadline')
        raise RuntimeError('Qualification interrupted or deadline reached')

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGALRM, interrupt)
    signal.alarm(2700 if args.operations_rehearsal or args.unattended or args.registry_scanner_image else 900)
    save()
    try:
        if args.unattended:
            state['demo'] = {'url': 'https://' + args.demo_host, 'unattended': True, 'previews': [],
                'stop_at': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=2700)).isoformat()}
            save()
            from cloudflare_demo import arm_deadline
            state['demo']['stop_timer'] = arm_deadline(directory/'ownership.json', 2700)
            save()
        command('build existing Golf CLI', ['go', 'build', '-o', str(directory/'golfctl'), './cmd/golfctl'], timeout=120)
        state['cli_sha256'] = hashlib.sha256((directory/'golfctl').read_bytes()).hexdigest()
        identity = cf('selected OAuth identity', 'auth', 'whoami')
        if not identity.get('authenticated') or not identity.get('tokenValid') or not identity.get('authSource', '').endswith('/' + args.profile + '.json') or args.account_id not in [a['id'] for a in identity.get('accounts', [])]:
            raise RuntimeError('OAuth profile/account mismatch')
        for label, argv in [('worker', ['workers', 'get', name]), ('namespace', ['artifacts', 'namespaces', 'get', name])]:
            result = command('fresh ' + label, ['cf', '--profile', args.profile, *argv], required=False)
            if not result.returncode or b'404 Not Found' not in result.stderr:
                raise RuntimeError('Target absence not confirmed')
        if cf('fresh database name', 'd1', 'list', '--name', name, '--per-page', '1'):
            raise RuntimeError('Database name exists')
        state['namespace_attempted'] = True
        save()
        cf('owned namespace create', 'artifacts', 'namespaces', 'create', '--namespace', name)
        state['resources']['namespace'] = name
        save()
        database = cf('owned database create', 'd1', 'create', '--name', name)
        if database['name'] != name:
            raise RuntimeError('Database identity mismatch')
        state['resources']['database'] = {'name': name, 'uuid': database['uuid']}
        save()
        query((ROOT/'cloudflare/forge/schema.sql').read_text())
        query('INSERT INTO workspaces(slug,artifact_namespace) VALUES(?,?)', ['alice', name])
        query("INSERT INTO users(id,login,can_create) VALUES(1,'alice',1),(2,'bob',0)")
        for token, user in [(owner, 1), (reader, 2)]:
            query('INSERT INTO credentials(digest,user_id,expires_at) VALUES(?,?,?)', [hashlib.sha256(token.encode()).hexdigest(), user, int(time.time()) + (3600 if args.unattended or args.registry_scanner_image else 18000 if demo else 900)])
        settings = {'account': args.account_id, 'worker': name, 'namespace': name, 'workspace': 'alice',
                    'database': state['resources']['database'], 'origin': f'https://{name}.{args.workers_subdomain}.workers.dev', 'workers_dev': True}
        if args.delivery:
            preview_name = name + '-preview'
            machine = cf('owned short-lived preview service token', 'zero-trust', 'access', 'service-tokens', 'create', '--name', preview_name, '--duration', '1h' if args.unattended or args.registry_scanner_image else '5h' if demo else '20m')
            redactions.append(machine['client_secret'])
            state['resources']['preview_service_token'] = {'id': machine['id'], 'name': machine['name']}
            save()
            preview_origin = 'https://' + args.app_host if args.apps else f'https://{preview_name}.{args.workers_subdomain}.workers.dev'
            if args.apps:
                matches = cf('existing preview Access inventory', 'zero-trust', 'access', 'applications', 'list', '--per-page', '100')
                if len(matches) >= 100 or any(a.get('domain') in [args.app_host, '*.' + args.app_host] for a in matches):
                    raise RuntimeError('Preview Access hostname already allocated')
            access_body = {
                'name': preview_name, 'type': 'self_hosted', 'domain': preview_origin.removeprefix('https://'), 'session_duration': '15m',
                'policies': [{'name': 'Owned machine qualification', 'decision': 'non_identity', 'include': [{'service_token': {'token_id': machine['id']}}]}]}
            if args.apps:
                access_body['destinations'] = [{'type': 'public', 'uri': host} for host in [args.app_host, '*.' + args.app_host]]
            app = cf('Access policy before preview publication', 'zero-trust', 'access', 'applications', 'create', '--body', json.dumps({
                **access_body}))
            state['resources']['preview_access'] = {'id': app['id'], 'name': app['name'], 'aud': app['aud']}
            settings['previews'] = {'worker': preview_name, 'origin': preview_origin, 'access_aud': app['aud'], 'path': 'public', 'ttl': 600, 'automatic': True, 'browser': True, 'workers_dev': True}
            query("UPDATE users SET email=CASE id WHEN 1 THEN 'alice@example.invalid' ELSE 'bob@example.invalid' END")
            save()
        if args.apps:
            groups = cf('scoped application permission discovery', 'user', 'tokens', 'permission-groups', 'list')
            selected = [g for g in groups if g['name'] in ['D1 Write', 'Workers Scripts Write', 'Workers R2 Storage Write', 'Secrets Store Write'] and g.get('is_selectable')]
            if len(selected) != 4:
                raise RuntimeError('Application provisioning permissions unavailable')
            policies = [{'effect': 'allow', 'resources': {'com.cloudflare.api.account.' + args.account_id: '*'}, 'permission_groups': [{'id': g['id']} for g in selected]}]
            expiry = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=60 if args.unattended else 300 if demo else 30)).strftime('%Y-%m-%dT%H:%M:%SZ')
            management = cf('thirty-minute application provisioning credential', 'user', 'tokens', 'create', '--name', name, '--expires-on', expiry, '--policies', json.dumps(policies))
            redactions.extend([management['value'], signing_key])
            state['resources']['management_token'] = {'id': management['id'], 'expires_at': expiry}
            save()
            if args.operations_rehearsal:
                selected = [g for g in groups if g['name'] == 'Account Analytics Read' and g.get('is_selectable')]
                if len(selected) != 1:
                    raise RuntimeError('Account Analytics Read permission unavailable')
                policy = [{'effect': 'allow', 'resources': {'com.cloudflare.api.account.' + args.account_id: '*'}, 'permission_groups': [{'id': selected[0]['id']}]}]
                analytics = cf('separate read-only Worker analytics credential', 'user', 'tokens', 'create', '--name', name + '-analytics', '--expires-on', expiry, '--policies', json.dumps(policy))
                redactions.append(analytics['value'])
                state['resources']['analytics_token'] = {'id': analytics['id'], 'expires_at': expiry}
                save()
            prefix = '/accounts/' + args.account_id
            stores = provider(prefix + '/secrets_store/stores')
            if stores:
                raise RuntimeError('Use an explicitly selected existing Secrets Store; qualification never adopts it')
            store = provider(prefix + '/secrets_store/stores', 'POST', {'name': name})
            if store.get('name') != name or not re.fullmatch('[a-f0-9]{32}', store.get('id', '')):
                raise RuntimeError('Secrets Store identity differs')
            state['resources']['secret_store'] = {'id': store['id'], 'name': name}
            save()
            secrets_to_store = [
                {'name': 'golf-management', 'value': management['value'], 'scopes': ['workers']},
                {'name': 'demo-signing', 'value': signing_key, 'scopes': ['workers']}]
            if analytics:
                secrets_to_store.append({'name': 'analytics-read', 'value': analytics['value'], 'scopes': ['workers']})
                settings['operations'] = {'service_health': True, 'analytics_secret': {'store': store['id'], 'name': 'analytics-read'}, 'observability': {'enabled': True, 'sampling': .1}}
            stored = provider(prefix + '/secrets_store/stores/' + store['id'] + '/secrets', 'POST', secrets_to_store)
            if {s['name'] for s in stored} != {s['name'] for s in secrets_to_store} or any(s.get('value') for s in stored):
                raise RuntimeError('Secrets Store metadata differs')
            state['resources']['secrets'] = [{'id': s['id'], 'name': s['name']} for s in stored]
            save()
            namespace = cf('owned dispatch namespace create', 'workers-for-platforms', 'dispatch-namespaces', 'create', '--name', name)
            if namespace['namespace_name'] != name:
                raise RuntimeError('Dispatch namespace identity differs')
            state['resources']['dispatch'] = namespace
            save()
            settings['apps'] = {'policy': {'namespace': name, 'entry': 'worker.mjs', 'migration': 'schema.sql', 'ttl': 14400 if demo else 600, 'zone': args.app_zone,
                'gateway': preview_name, 'outbound': name + '-outbound', 'secret': {'store': store['id'], 'name': 'demo-signing'}}, 'automatic': True,
                'provisioner': {'store': store['id'], 'name': 'golf-management'}}
        if demo:
            domains = provider(prefix + '/workers/domains')
            if any(d['hostname'] in [args.demo_host, args.app_host] for d in domains):
                raise RuntimeError('Demo control hostname already allocated')
            existing_access = cf('demo control Access inventory', 'zero-trust', 'access', 'applications', 'list', '--per-page', '100')
            if len(existing_access) >= 100 or any(a.get('domain') == args.demo_host for a in existing_access):
                raise RuntimeError('Demo control Access hostname already allocated')
            if not args.unattended:
                identity_provider = cf('owned demo email-code provider', 'zero-trust', 'identity-providers', 'create', '--body', json.dumps({'name': name, 'type': 'onetimepin', 'config': {}}))
                state['resources']['demo_idp'] = {'id': identity_provider['id'], 'name': identity_provider['name']}
                save()
                human_policy = {'name': 'Approved demo owner', 'decision': 'allow', 'include': [{'email': {'email': args.demo_email}}]}
                access_body.update(allowed_idps=[identity_provider['id']], auto_redirect_to_identity=True, session_duration='4h')
                access_body['policies'].append(human_policy)
                cf('own preview human Access policy', 'zero-trust', 'access', 'applications', 'update', app['id'], '--body', json.dumps(access_body))
            control_body = {'name': name + '-control', 'type': 'self_hosted', 'domain': args.demo_host,
                'session_duration': '1h' if args.unattended else '4h', 'policies': [access_body['policies'][0]]}
            if not args.unattended:
                control_body.update(allowed_idps=[identity_provider['id']], auto_redirect_to_identity=True, policies=[human_policy, access_body['policies'][0]])
            control_access = cf('demo control Access before publication', 'zero-trust', 'access', 'applications', 'create', '--body', json.dumps(control_body))
            state['resources']['control_access'] = {'id': control_access['id'], 'name': control_access['name'], 'aud': control_access['aud']}
            settings.update(hostname=args.demo_host, origin='https://' + args.demo_host, access_aud=control_access['aud'], automatic_ci=True,
                workers_dev=False, ui=True, web_assets=str(ROOT/'web/dist-native'))
            settings['previews']['ttl'] = 14400
            settings['previews']['workers_dev'] = False
            state['control_domain_attempted'] = True
            state['preview_domain_attempted'] = True
            save()
            command('build native demo frontend', ['npm', 'run', 'build:native'], cwd=ROOT/'web', timeout=120)
        if args.container_tests:
            if cf('fresh test container target', 'containers', 'applications', 'list', '--name', name, '--per-page', '10'):
                raise RuntimeError('Container target already exists')
            if cf('fresh test image target', 'containers', 'images', 'list', '--filter', '^' + re.escape(name) + '$'):
                raise RuntimeError('Image target already exists')
            metadata = json.loads(command('approved test image identity', ['docker', 'image', 'inspect', 'golf-cf-agent:qualification', '--format', '{{json .}}']).stdout)
            if metadata['Architecture'] != 'amd64' or metadata['Os'] != 'linux' or not re.fullmatch('sha256:[a-f0-9]{64}', metadata['Id']):
                raise RuntimeError('Approved test image must be linux/amd64')
            if (metadata.get('Descriptor') or {}).get('mediaType') not in ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']:
                raise RuntimeError('Approved test image must be a single manifest')
            image = name + ':qualification'
            state['resources']['test_image'] = {'tag': image, 'id': metadata['Id']}
            save()
            command('tag approved test image', ['docker', 'tag', metadata['Id'], image])
            settings['tests'] = {'module': 'test_calc', 'image': image, 'image_id': metadata['Id']}
            if args.agents:
                if cf('fresh agent container target', 'containers', 'applications', 'list', '--name', name + '-agents', '--per-page', '10'):
                    raise RuntimeError('Agent container target already exists')
                settings['agent_path'] = 'calc.py'
        if args.evidence:
            for label, argv in [('bucket', ['r2', 'buckets', 'get', name]), ('workflow', ['workflows', 'get', name])]:
                result = command('fresh evidence ' + label, ['cf', '--profile', args.profile, *argv], required=False)
                if not result.returncode or b'404 Not Found' not in result.stderr:
                    raise RuntimeError('Evidence target absence not confirmed')
            queues = cf('fresh queue inventory', 'queues', 'list')
            if not isinstance(queues, list) or any(q['queue_name'] == name for q in queues):
                raise RuntimeError('Queue target absence not confirmed')
            bucket = cf('owned evidence bucket create', 'r2', 'buckets', 'create', '--name', name)
            if bucket['name'] != name or not bucket.get('creation_date'):
                raise RuntimeError('Evidence bucket identity mismatch')
            state['resources']['bucket'] = {'name': name, 'creation_date': bucket['creation_date']}
            save()
            managed = cf('private evidence bucket', 'r2', 'buckets', 'domains', 'managed', 'list', '--bucket-name', name)
            if managed['enabled']:
                raise RuntimeError('Evidence bucket is public')
            queue = cf('owned evidence queue create', 'queues', 'create', '--queue-name', name)
            if queue['queue_name'] != name or not queue.get('queue_id'):
                raise RuntimeError('Queue identity mismatch')
            state['resources']['queue'] = {'name': name, 'id': queue['queue_id']}
            save()
            settings['evidence'] = {'bucket': name, 'queue': name, 'workflow': name, 'daily_limit': evidence_limit, 'allow_ai': args.evidence_ai}
            if args.evidence_ai:
                result = command('fresh evidence gateway', ['cf', '--profile', args.profile, 'ai-gateway', 'gateways', 'get', name], required=False)
                if not result.returncode or b'404 Not Found' not in result.stderr:
                    diagnostic = directory/'gateway-discovery-failure.txt'
                    diagnostic.write_bytes(result.stderr)
                    diagnostic.chmod(0o600)
                    raise RuntimeError('Gateway absence not confirmed')
                gateway = cf('owned evidence gateway create', 'ai-gateway', 'gateways', 'create', '--body', json.dumps({
                    'id': name, 'authentication': True, 'collect_logs': False, 'cache_ttl': 0, 'cache_invalidate_on_update': False,
                    'rate_limiting_interval': 60, 'rate_limiting_limit': 30 if args.agents else 3, 'rate_limiting_technique': 'fixed', 'retry_max_attempts': 1,
                    'workers_ai_billing_mode': 'postpaid'}))
                if gateway['id'] != name:
                    raise RuntimeError('Gateway identity mismatch')
                state['resources']['gateway'] = name
                settings['evidence']['gateway'] = name
                save()

        def build(mode='build'):
            if mode == 'build' and settings.get('tests'):
                command('restore approved image for native build', ['docker', 'tag', settings['tests']['image_id'], settings['tests']['image']])
            (directory/'forge.json').write_text(json.dumps(settings))
            command('native forge build ' + mode, ['node', 'cloudflare/forge/prepare.mjs', str(directory), shutil.which('cf'), mode])

        build()
        if args.apps:
            state['app_outbound_attempted'] = True
            save()
            command('owned outbound Worker deployment', ['cf', '--profile', args.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=directory/'app-outbound', timeout=120)
            outbound = cf('outbound Worker identity', 'workers', 'get', name + '-outbound')
            state['resources']['app_outbound'] = {'id': outbound['id'], 'name': outbound['name']}
            save()
        state['worker_attempted'] = True
        state['workflow_attempted'] = bool(args.evidence)
        save()
        deployed = command('owned Worker deployment', ['cf', '--profile', args.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=directory, timeout=120)
        urls = re.findall(rb'https://[^\s]+\.workers\.dev', deployed.stdout)
        if not demo and len(urls) != 1:
            raise RuntimeError('Expected one owned Worker origin')
        url = settings['origin'] if demo else urls[0].decode()
        metadata = cf('Worker identity readback', 'workers', 'get', name)
        if metadata['name'] != name or (metadata['subdomain']['enabled'] if demo else metadata['subdomain']['url'] != url) or url != settings['origin']:
            raise RuntimeError('Worker identity mismatch')
        state['resources']['worker'] = {'id': metadata['id'], 'name': name, 'url': url}
        settings['origin'] = url
        if demo:
            allocated = [d for d in provider(prefix + '/workers/domains') if d['hostname'] == args.demo_host]
            if len(allocated) != 1 or allocated[0]['service'] != name or allocated[0]['zone_id'] != args.app_zone:
                raise RuntimeError('Demo control domain identity differs')
            state['resources']['control_domain'] = allocated[0]
        save()
        # Session lookup is side-effect free and may wait for fresh platform routing.
        await_session(lambda: http('/rpc/golf.v1.SessionService/GetSession'))
        if args.registry_host:
            from cloudflare_registry_check import RegistryProof
            registry = RegistryProof(directory, state, args, cf, command, provider, save, redactions)
            registry.provision(settings)
            build()
            command('bind Golf to owned registry', ['cf', '--profile', args.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=directory, timeout=180)
            await_session(lambda: http('/rpc/golf.v1.SessionService/GetSession'))
        if args.unattended:
            replace_private_json(directory/'qualification-auth.json', {'origin': url, 'expires_at': state['demo']['stop_at'],
                'headers': {'Authorization': 'Bearer ' + owner, 'CF-Access-Client-Id': machine['client_id'], 'CF-Access-Client-Secret': machine['client_secret']}})
        state['checks'].pop('last_http_failure', None)
        http('/rpc/golf.v1.SessionService/GetSession', token=None, expected=401)
        if args.delivery:
            preview_root = directory/'preview-worker'
            (directory/'preview-proof.json').write_text(json.dumps({'digest': hashlib.sha256(('Bearer ' + owner).encode()).hexdigest(), 'origin': settings['previews']['origin']}))
            command('scoped hosted preview proof build', ['node', 'cloudflare/forge/prepare-proof.mjs', str(preview_root), shutil.which('cf')])
            state['preview_worker_attempted'] = True
            save()
            command('owned preview Worker deployment', ['cf', '--profile', args.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=preview_root, timeout=120)
            preview_meta = cf('preview Worker identity', 'workers', 'get', settings['previews']['worker'])
            if preview_meta['name'] != settings['previews']['worker'] or (not args.apps and preview_meta['subdomain']['url'] != settings['previews']['origin']):
                raise RuntimeError('Preview Worker identity changed')
            state['resources']['preview_worker'] = {'id': preview_meta['id'], 'name': preview_meta['name']}
            save()
            if args.apps:
                domains = provider(prefix + '/workers/domains')
                allocated = [d for d in domains if d['hostname'] == args.app_host]
                if demo:
                    if len(allocated) != 1 or allocated[0]['service'] != preview_name or allocated[0]['zone_id'] != args.app_zone:
                        raise RuntimeError('Owned preview domain identity differs')
                    domain = allocated[0]
                else:
                    if allocated:
                        raise RuntimeError('Preview hostname already allocated')
                    domain = provider(prefix + '/workers/domains', 'PUT', {'hostname': args.app_host, 'service': preview_name, 'environment': 'production', 'zone_id': args.app_zone})
                state['resources']['preview_domain'] = domain
                save()
        if args.evidence:
            workflow = cf('owned evidence workflow readback', 'workflows', 'get', name)
            if workflow['name'] != name or workflow['script_name'] != name or workflow['class_name'] != 'EvidenceWorkflow':
                raise RuntimeError('Workflow identity mismatch')
            state['resources']['workflow'] = {'name': name, 'script_name': name, 'class_name': 'EvidenceWorkflow'}
            save()
        intent = {'name': 'canonical', 'description': 'Disposable native Git qualification', 'private': True, 'idempotencyKey': str(uuid.uuid4())}
        created = rpc('CreateRepository', intent)
        if created.get('creation', {}).get('state') != 'REPOSITORY_CREATION_STATE_SUCCEEDED':
            raise RuntimeError('Native repository creation not confirmed')
        repository = created['repository']
        state['checks']['repository_id'] = repository['id']
        if rpc('CreateRepository', intent)['repository']['id'] != repository['id']:
            raise RuntimeError('Creation replay changed repository')
        rpc('CreateRepository', {**intent, 'name': 'different'}, expected=409)
        key = {'owner': 'alice', 'name': 'canonical'}
        rpc('GetRepository', {'repository': key}, token=reader, expected=404)
        source = directory/'source'
        git('fresh source repository', 'init', '-b', 'main', source)
        if args.unattended:
            (source/'.github').mkdir()
            (source/'.github/CODEOWNERS').write_text('*.txt @bob\n')
            git('stage CODEOWNERS fixture', '-C', source, 'add', '.github/CODEOWNERS')
        if args.container_tests:
            (source/'.github/workflows').mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT/'docs/compatibility/fixtures/requests-lint.yml', source/'.github/workflows/lint.yml')
            shutil.copyfile(ROOT/'docs/compatibility/fixtures/gitlab-shell.yml', source/'.gitlab-ci.yml')
            (source/'README.md').write_text('Disposable pipeline qualification source.\n')
            git('stage canonical pipeline fixtures', '-C', source, 'add', '.github/workflows/lint.yml', '.gitlab-ci.yml', 'README.md')
        (source/'hello.txt').write_text('Canonical Git stored in Cloudflare Artifacts.\n')
        (source/'link').symlink_to('hello.txt')
        (source/'nested').mkdir()
        (source/'nested'/'data.bin').write_bytes(bytes([0, 255, 1, 2]))
        git('add original source', '-C', source, 'add', 'hello.txt', 'link', 'nested/data.bin')
        git('commit original source', '-C', source, 'commit', '-m', 'Native canonical Git')
        commit = git('source identity', '-C', source, 'rev-parse', 'HEAD').stdout.decode().strip()
        # Warm/read the same native Git client path; never retry a Git write.
        for readiness_attempt in range(5):
            ready = git('native Git read readiness', 'ls-remote', repository['cloneUrl'], required=False)
            if ready.returncode == 0:
                break
            if readiness_attempt == 4:
                raise RuntimeError('Native Git client read readiness failed')
            time.sleep(1)
        http('/git/alice/canonical.git/info/refs?service=git-receive-pack', method='GET', raw=True)
        git('push through native Golf authorization', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/main')
        clone = directory/'clone'
        for clone_attempt in range(5):
            cloned = git('clone canonical Artifacts through Golf', 'clone', repository['cloneUrl'], clone, required=False)
            if cloned.returncode == 0:
                break
            state['checks'].setdefault('clone_failures', []).append(cloned.stderr.decode(errors='replace').replace(owner, '[private]').replace(reader, '[private]')[-1500:])
            save()
            if clone_attempt == 4:
                raise RuntimeError('Canonical clone failed after bounded read retries')
            # This path is created only by this run's clone; never remove user work.
            if clone.exists():
                shutil.rmtree(clone)
            http('/git/alice/canonical.git/info/refs?service=git-upload-pack', method='GET', raw=True)

        if git('clone identity', '-C', clone, 'rev-parse', 'HEAD').stdout.decode().strip() != commit:
            raise RuntimeError('Canonical clone differs')
        content = rpc('GetContents', {'repository': key, 'repositoryId': repository['id'], 'ref': commit, 'path': 'hello.txt'})
        if content.get('file', {}).get('content') != (source/'hello.txt').read_text():
            raise RuntimeError('Immutable native file differs')
        exact = {'repository': key, 'repositoryId': repository['id'], 'ref': commit}
        tree = rpc('GetContents', exact)
        kinds = {entry['name']: entry['type'] for entry in tree.get('entries', [])}
        expected_kinds = {'hello.txt': 'SOURCE_ENTRY_TYPE_FILE', 'link': 'SOURCE_ENTRY_TYPE_SYMLINK', 'nested': 'SOURCE_ENTRY_TYPE_DIRECTORY'}
        if args.unattended or args.container_tests: expected_kinds['.github'] = 'SOURCE_ENTRY_TYPE_DIRECTORY'
        if args.container_tests: expected_kinds.update({'.gitlab-ci.yml': 'SOURCE_ENTRY_TYPE_FILE', 'README.md': 'SOURCE_ENTRY_TYPE_FILE'})
        if kinds != expected_kinds:
            raise RuntimeError('Native tree identity differs')
        if args.container_tests:
            capabilities = http('/rpc/golf.v1.CapabilityService/ListCapabilities', {})
            workflow_capability = next(c for c in capabilities['capabilities'] if c['id'] == 'settings.repository-workflows')
            if workflow_capability['state'] != 'CAPABILITY_STATE_DISABLED':
                raise RuntimeError('Requalify native pipeline execution before enabling its capability')
            pipeline_receipts = []
            for path in ['.github/workflows/lint.yml', '.gitlab-ci.yml']:
                canonical = rpc('GetContents', {**exact, 'path': path})
                data = (source/path).read_bytes()
                if canonical.get('file', {}).get('content', '').encode() != data:
                    raise RuntimeError('Canonical pipeline fixture bytes differ')
                request = {'repository': key, 'workflowPath': path, 'ref': commit, 'idempotencyKey': str(uuid.uuid4())}
                for method in ['InspectWorkflows', 'DispatchWorkflow']:
                    service = 'WorkflowService' if method == 'InspectWorkflows' else 'WorkflowRunService'
                    result = http('/rpc/golf.v1.' + service + '/' + method, request, expected=501)
                    if result.get('code') != 'unimplemented':
                        raise RuntimeError('Unsupported native pipeline did not return a typed refusal')
                pipeline_receipts.append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'sourceCommit': commit,
                                          'storedInArtifacts': True, 'execution': 'unsupported', 'admissionStatus': 501})
            state['checks']['pipeline_execution_boundary'] = pipeline_receipts
            save()
        link = rpc('GetContents', {**exact, 'path': 'link'})
        if link.get('kind') != 'SOURCE_ENTRY_TYPE_SYMLINK' or link.get('file', {}).get('content') != 'hello.txt':
            raise RuntimeError('Native symlink identity differs')
        rpc('GetContents', {**exact, 'path': 'link/hello.txt'}, expected=404)
        binary = rpc('GetContents', {**exact, 'path': 'nested/data.bin'})
        if 'content' in binary.get('file', {}) or binary.get('file', {}).get('entry', {}).get('size') != '4':
            raise RuntimeError('Native binary preview differs')
        selected = rpc('ResolveRepositorySource', {'repository': key, 'repositoryId': repository['id']})
        if selected.get('selection', {}).get('commitId') != commit:
            raise RuntimeError('Native immutable source selection differs')
        branches = rpc('ListBranches', {'repository': key, 'repositoryId': repository['id']})
        if not any(b['name'] == 'main' and b['commitId'] == commit for b in branches.get('branches', [])):
            raise RuntimeError('Native branch identity differs')
        cli_environment = {k: v for k, v in environment.items() if k not in ['GOLF_API_TOKEN', 'GOLF_GITEA_TOKEN', 'GOLF_NATIVE_TOKEN', 'GOLF_URL']}
        cli_environment['GOLF_NATIVE_TOKEN'] = owner
        if demo:
            cli_environment.update(GOLF_ACCESS_CLIENT_ID=machine['client_id'], GOLF_ACCESS_CLIENT_SECRET=machine['client_secret'])
        cli_input = {'repository': key, 'repositoryId': repository['id'], 'title': 'Created with actual Golf CLI', 'body': 'Native credential and generated Connect contract', 'idempotencyKey': str(uuid.uuid4())}
        cli_file = directory/'cli-issue.json'
        cli_file.write_text(json.dumps(cli_input))
        cli_file.chmod(0o600)
        cli_args = [str(directory/'golfctl'), '--url', url, 'issue', 'create', '--input', str(cli_file)]
        cli_created = command('native Golf CLI issue create', cli_args, env=cli_environment, required=False)
        if cli_created.returncode:
            # Inspect only the original key; never allocate another write operation.
            rpc('GetIssueMutation', {'idempotencyKey': cli_input['idempotencyKey']}, expected=(200, 404))
            cli_created = command('native Golf CLI original issue create replay', cli_args, env=cli_environment)
        cli_issue = json.loads(cli_created.stdout)['data']['issue']
        cli_read = command('native Golf CLI issue read', [str(directory/'golfctl'), '--url', url, 'issue', 'view', 'alice/canonical', str(cli_issue['number'])], env=cli_environment)
        if json.loads(cli_read.stdout)['data']['issue']['id'] != cli_issue['id']:
            raise RuntimeError('Existing Golf CLI native contract differs')
        issue_input = {'repository': key, 'repositoryId': repository['id'], 'title': 'Native D1 issue', 'body': 'Real private collaboration', 'idempotencyKey': str(uuid.uuid4())}
        issue_created = rpc('CreateIssue', issue_input)
        issue = issue_created['issue']
        if rpc('CreateIssue', issue_input)['issue']['id'] != issue['id']:
            raise RuntimeError('Native issue replay differs')
        rpc('GetIssue', {'repository': key, 'number': issue['number']}, token=reader, expected=404)
        comment_input = {'repository': key, 'repositoryId': repository['id'], 'issueId': issue['id'], 'number': issue['number'], 'body': 'Native D1 reply', 'idempotencyKey': str(uuid.uuid4())}
        comment = rpc('CreateIssueComment', comment_input)['comment']
        if rpc('CreateIssueComment', comment_input)['comment']['id'] != comment['id'] or len(rpc('ListIssueComments', comment_input)['comments']) != 1:
            raise RuntimeError('Native comment replay differs')
        current_issue = rpc('GetIssue', {'repository': key, 'number': issue['number']})['issue']
        update = {'repository': key, 'repositoryId': repository['id'], 'issueId': issue['id'], 'number': issue['number'], 'expectedRevision': current_issue['revision'], 'title': 'Updated native issue', 'idempotencyKey': str(uuid.uuid4())}
        if rpc('UpdateIssue', update)['issue']['title'] != update['title']:
            raise RuntimeError('Native issue update differs')
        rpc('UpdateIssue', {**update, 'idempotencyKey': str(uuid.uuid4())}, expected=412)
        git('create native feature branch', '-C', source, 'checkout', '-b', 'feature')
        (source/'hello.txt').write_text('Native Artifacts collaboration proposal.\n')
        git('add feature change', '-C', source, 'add', 'hello.txt')
        if args.container_tests:
            (source/'calc.py').write_text('def add(a, b):\n    return a + b\n')
            (source/'test_calc.py').write_text('import unittest\nfrom calc import add\nclass Math(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n    def test_network_denied(self):\n        import urllib.request, urllib.error\n        with self.assertRaises(urllib.error.HTTPError) as caught:\n            urllib.request.urlopen("https://example.com/", timeout=5)\n        self.assertEqual(caught.exception.code, 403)\n')
            if args.delivery:
                (source/'public').mkdir()
                (source/'public'/'index.html').write_text('<!doctype html><html><head><title>Golf native preview</title><style>body{background:#101010;color:#d4ff3a;font:32px sans-serif;padding:64px}</style></head><body><h1>Golf native preview</h1><p>Exact PR assets from Artifacts, privately retained in R2.</p></body></html>')
                git('stage approved preview assets', '-C', source, 'add', 'public/index.html')
            if args.apps:
                module = (ROOT/'cloudflare/forge/demo/worker.mjs').read_text().replace("const path = new URL(request.url).pathname;", "const path = new URL(request.url).pathname;\n    if(path==='/egress') return Response.json({status:(await fetch('https://example.com/')).status});")
                module = module.replace('return Response.json({ id },', 'return Response.json({ id, signature, receipt },')
                (source/'worker.mjs').write_text(module)
                shutil.copyfile(ROOT/'cloudflare/forge/demo/schema.sql', source/'schema.sql')
                git('stage approved managed application', '-C', source, 'add', 'worker.mjs', 'schema.sql')
            git('stage operator-approved native tests', '-C', source, 'add', 'calc.py', 'test_calc.py')
            if registry:
                registry.enable(http, repository)
                if args.registry_scanner_image:
                    registry.enable_automatic_scans(http, repository)
                publisher = ROOT / 'scripts/fixtures/registry_publish.py'
                shutil.copyfile(publisher, source/'registry_publish.py')
                test_file = source/'test_calc.py'
                test_file.write_text(test_file.read_text().replace('self.assertEqual(add(2, 3), 5)', 'self.assertEqual(add(2, 3), 5); __import__("registry_publish").publish()'))
                git('stage exact-source registry publisher', '-C', source, 'add', 'registry_publish.py', 'test_calc.py')
        git('commit feature change', '-C', source, 'commit', '-m', 'Native proposal')
        head = git('feature identity', '-C', source, 'rev-parse', 'HEAD').stdout.decode().strip()
        git('push native feature branch', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/feature')
        pull_input = {'repository': key, 'repositoryId': repository['id'], 'sourceRepository': key, 'sourceRepositoryId': repository['id'], 'baseBranch': 'main', 'headBranch': 'feature', 'baseCommitId': commit, 'headCommitId': head, 'title': 'Native PR', 'body': 'Real Artifacts refs and D1 proposal', 'idempotencyKey': str(uuid.uuid4())}
        proposed = rpc('CreatePullRequest', pull_input)
        pr = proposed['pullRequest']
        discussion_id = query('SELECT discussion_id FROM pull_requests WHERE id=?', [pr['id']])[0]['results'][0]['discussion_id']
        if proposed['mutation']['pullRequestId'] != pr['id'] or rpc('CreatePullRequest', pull_input)['pullRequest']['id'] != pr['id'] or rpc('GetPullRequestDiscussion', {'repository': key, 'number': pr['number']})['issue']['id'] != str(discussion_id):
            raise RuntimeError('Native proposal identity differs')
        grant = {'repository': key, 'repositoryId': repository['id'], 'userId': '2', 'role': 'read'}
        http('/native/repository-grant', grant)
        review_input = {'repository': key, 'repositoryId': repository['id'], 'pullRequestId': pr['id'], 'number': pr['number'], 'expectedRevision': pr['revision'], 'baseCommitId': commit, 'headCommitId': head, 'state': 'PULL_REQUEST_REVIEW_STATE_APPROVED', 'body': '', 'idempotencyKey': str(uuid.uuid4())}
        rpc('CreatePullRequestReview', review_input, expected=403)
        review = rpc('CreatePullRequestReview', review_input, token=reader)['review']
        if review['stale'] or review['official'] or rpc('CreatePullRequestReview', review_input, token=reader)['review']['id'] != review['id']:
            raise RuntimeError('Native overall review binding differs')
        check_input = {'repository': key, 'repositoryId': repository['id'], 'commitId': head, 'context': 'qualification/reported-status', 'state': 'REPORTED_CHECK_STATE_SUCCESS', 'description': 'Controlled reported status; not CI execution evidence', 'idempotencyKey': str(uuid.uuid4())}
        http('/native/repository-check', check_input, token=reader, expected=404)
        reported = http('/native/repository-check', check_input)['check']
        if http('/native/repository-check', check_input)['check']['id'] != reported['id']:
            raise RuntimeError('Native check replay differs')
        selection = {'repository': key, 'repositoryId': repository['id'], 'pullRequestId': pr['id'], 'number': pr['number'], 'baseCommitId': commit, 'headCommitId': head}
        checks = rpc('ListPullRequestChecks', {'selection': selection})['checks']
        if len(checks) != 1 or checks[0]['id'] != reported['id']:
            raise RuntimeError('Native commit check binding differs')
        if args.evidence:
            request = {'action': 'create', 'selection': selection, 'advice': args.evidence_ai, 'idempotencyKey': str(uuid.uuid4())}
            if args.container_tests:
                request['runTests'] = True
            state['checks']['evidence_operation_key'] = request['idempotencyKey']
            save()
            http('/native/pr-evidence', request, token=reader, expected=404)
            if args.ci_resilience:
                with ThreadPoolExecutor(max_workers=6) as pool:
                    replayed = list(pool.map(lambda _: http('/native/pr-evidence', request)['job'], range(6)))
                if len({item['id'] for item in replayed}) != 1:
                    raise RuntimeError('Concurrent original intent produced different jobs')
                job = replayed[0]
                http('/native/pr-evidence', {**request, 'runTests': False}, expected=409)
                count = query('SELECT count(*) AS n FROM evidence_jobs WHERE user_id=1 AND operation_key=?', [request['idempotencyKey']])[0]['results'][0]['n']
                if count != 1: raise RuntimeError('Concurrent replay allocated more than one job')
                state['checks']['concurrent_evidence_replay'] = {'requests': 6, 'jobs': count, 'changedInputsDenied': True}
            else:
                job = http('/native/pr-evidence', request)['job']
            if http('/native/pr-evidence', request)['job']['id'] != job['id']:
                raise RuntimeError('Evidence replay changed job identity')
            state['checks']['evidence_job_id'] = job['id']
            save()
            inspection = {'action': 'status', 'jobId': job['id'], 'repository': key, 'repositoryId': repository['id']}
            for attempt in range(240 if args.container_tests else 120):
                job = http('/native/pr-evidence', inspection)['job']
                if job['state'] in ['SUCCEEDED', 'REFUSED', 'EXPIRED']:
                    break
                time.sleep(1)
            if job['state'] != 'SUCCEEDED' or job['delivery'] != 'STARTED':
                raise RuntimeError('Native queued evidence did not complete')
            downloaded = http('/native/pr-evidence', {**inspection, 'action': 'report'}, token=reader)
            report = downloaded['report']
            if report['selection'] != selection or report['reportedChecks'][0]['id'] != reported['id'] or not report['advisoryOnly'] or downloaded['job']['stale']:
                raise RuntimeError('Native evidence source binding differs')
            if args.evidence_ai and (report['advice']['state'] != 'SUCCEEDED' or not report['advice'].get('usage')):
                raise RuntimeError('Real native Clef advice not qualified')
            if args.container_tests:
                tests = report.get('tests', {})
                expected_tree = git('exact native PR test tree', '-C', source, 'rev-parse', 'HEAD^{tree}').stdout.decode().strip()
                if tests.get('state') != 'PASSED' or tests.get('exitCode') != 0 or tests.get('cleanup') != 'destroyed' or tests.get('commitId') != head or tests.get('treeId') != expected_tree or 'Ran 2 tests' not in tests.get('stderr', '') or tests.get('deniedRequests', 0) < 1:
                    state['checks']['container_test_failure'] = tests
                    save()
                    raise RuntimeError('Real exact-commit native container tests did not pass')
                state['checks']['native_container_tests'] = tests
            object_key = f"pr-evidence/alice/{repository['id']}/{job['id']}/{job['reportSha256']}.json"
            state['checks'].update(queued_workflow_r2_evidence=True, evidence_object_key=object_key, evidence_sha256=job['reportSha256'],
                                   clef_advisory=report['advice'], evidence_reader_access=True)
            retained = directory/'pr-evidence.json'
            retained.write_text(json.dumps(downloaded, indent=2) + '\n')
            retained.chmod(0o600)
            save()
        if args.ci_resilience:
            other = rpc('CreateRepository', {'name': 'ci-isolation', 'private': True, 'idempotencyKey': str(uuid.uuid4())})['repository']
            foreign = {**inspection, 'repository': {'owner': 'alice', 'name': other['name']}, 'repositoryId': other['id']}
            for action in ['status', 'report', 'cancel']:
                http('/native/pr-evidence', {**foreign, 'action': action}, expected=404)
                http('/native/pr-evidence', {**foreign, 'action': action}, token=reader, expected=404)
            git('create cancellation branch', '-C', source, 'checkout', '-b', 'ci-cancel')
            (source/'test_calc.py').write_text('import time, unittest\nclass Cancellation(unittest.TestCase):\n    def test_wait(self): time.sleep(45)\n')
            git('stage cancellation fixture', '-C', source, 'add', 'test_calc.py')
            git('commit cancellation fixture', '-C', source, 'commit', '-m', 'Bounded cancellation qualification')
            cancel_head = git('cancellation source identity', '-C', source, 'rev-parse', 'HEAD').stdout.decode().strip()
            git('push cancellation branch', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/ci-cancel')
            cancel_pr = rpc('CreatePullRequest', {**pull_input, 'headBranch': 'ci-cancel', 'headCommitId': cancel_head, 'title': 'Cancellation qualification', 'idempotencyKey': str(uuid.uuid4())})['pullRequest']
            git('restore original feature branch', '-C', source, 'checkout', 'feature')
            cancelled_input = {**request, 'selection': {**selection, 'pullRequestId': cancel_pr['id'], 'number': cancel_pr['number'], 'headCommitId': cancel_head}, 'idempotencyKey': str(uuid.uuid4())}
            cancelled_job = http('/native/pr-evidence', cancelled_input)['job']
            cancel_selection = {**inspection, 'jobId': cancelled_job['id']}
            for attempt in range(120):
                cancelled_job = http('/native/pr-evidence', cancel_selection)['job']
                if cancelled_job['testState'] == 'RUNNING': break
                if cancelled_job['state'] != 'QUEUED': raise RuntimeError('Cancellation fixture finished before admission was observed')
                time.sleep(1)
            if cancelled_job['testState'] != 'RUNNING': raise RuntimeError('Cancellation fixture was not admitted')
            http('/native/pr-evidence', {**cancel_selection, 'action': 'cancel'}, token=reader, expected=404)
            stopped = http('/native/pr-evidence', {**cancel_selection, 'action': 'cancel'})['job']
            stopped_again = http('/native/pr-evidence', {**cancel_selection, 'action': 'cancel'})['job']
            state['checks']['cancellation_observed'] = [{k: item[k] for k in ['state', 'testState']} for item in [cancelled_job, stopped, stopped_again]]
            save()
            if any(item['state'] != 'REFUSED' or item['testState'] != 'CANCELLED' for item in [stopped, stopped_again]):
                raise RuntimeError('Admitted cancellation was not terminal and idempotent')
            http('/native/pr-evidence', {**cancel_selection, 'action': 'report'}, expected=412)
            result = json.loads(query('SELECT test_result FROM evidence_jobs WHERE id=?', [stopped['id']])[0]['results'][0]['test_result'])
            if result['state'] != 'CANCELLED' or result['cleanup'] != 'destroyed': raise RuntimeError('Cancelled container cleanup unconfirmed')
            if http('/native/pr-evidence', cancelled_input)['job']['id'] != stopped['id']: raise RuntimeError('Cancelled original intent was reexecuted')
            state['checks']['admitted_cancellation'] = {'state': stopped['state'], 'testState': result['state'], 'cleanup': result['cleanup'], 'repeatCancelStable': True, 'readerCancelDenied': True, 'reportDenied': True, 'originalReplayStable': True}
            state['checks']['cross_repository_evidence_denied'] = {'ownerRequests': 3, 'readerRequests': 3}
            save()
        if args.delivery:
            preview_context = {'repository': key, 'repositoryId': repository['id']}
            for attempt in range(90):
                inventory = http('/native/pr-preview', {**preview_context, 'action': 'list'}, token=reader)['previews']
                published = [p for p in inventory if p['jobId'] == job['id'] and p['kind'] == 'STATIC']
                if len(published) == 1 and published[0]['state'] == 'READY':
                    break
                time.sleep(1)
            if len(published) != 1 or published[0]['state'] != 'READY' or published[0]['commitId'] != head:
                raise RuntimeError('Automatic exact-source preview publication differs')
            protected = published[0]
            if args.unattended:
                state['demo']['previews'].append(protected); save()
            state['checks']['native_preview'] = protected
            admission = http('/native/pr-preview', {**preview_context, 'action': 'grant', 'previewId': protected['id']}, token=reader)
            redactions.append(admission['grant'])
            exchange = {'previewId': protected['id'], 'email': 'bob@example.invalid', 'method': 'POST', 'path': '__golf/auth', 'origin': url, 'grant': admission['grant']}
            preview_rpc(exchange, expected=(302, 403), access=False)
            session = preview_rpc(exchange)['session']
            redactions.append(session)
            preview_rpc(exchange, expected=404)
            read_preview = {'previewId': protected['id'], 'email': 'bob@example.invalid', 'method': 'GET', 'path': '', 'credential': session}
            actual = preview_rpc(read_preview)
            if actual['content'] != (source/'public/index.html').read_text() or actual['commitId'] != head:
                raise RuntimeError('Live scoped preview RPC changed private assets')
            http('/native/repository-grant', {**grant, 'role': 'none'})
            preview_rpc(read_preview, expected=404)
            http('/native/repository-grant', grant)
            captured = http('/native/pr-preview', {**preview_context, 'action': 'capture', 'previewId': protected['id']})['preview']
            if captured['captureState'] != 'READY' or captured['captureBytes'] < 24:
                state['checks']['native_browser_capture'] = captured
                save()
                raise RuntimeError('Real Browser Run binding did not produce private evidence')
            image = http('/native/pr-preview', {**preview_context, 'action': 'screenshot', 'previewId': protected['id']}, token=reader, raw=True)
            if image[:8] != bytes([137,80,78,71,13,10,26,10]) or hashlib.sha256(image).hexdigest() != captured['captureSha256']:
                raise RuntimeError('Private Browser Run PNG identity differs')
            (directory/'preview-snapshot.png').write_bytes(image)
            state['checks'].update(native_preview_rpc=True, preview_outer_access_denial=True, preview_grant_replay_denied=True,
                                   preview_reader_revocation=True, native_browser_capture=captured, actual_reviewer_access_login=False)
            save()
        if args.apps:
            for attempt in range(90):
                inventory = http('/native/pr-preview', {**preview_context, 'action': 'list'}, token=reader)['previews']
                app_previews = [p for p in inventory if p['jobId'] == job['id'] and p['kind'] == 'WORKER']
                if len(app_previews) == 1 and app_previews[0]['state'] == 'READY':
                    break
                time.sleep(1)
            if len(app_previews) != 1 or app_previews[0]['state'] != 'READY':
                state['checks']['app_publication_failure'] = app_previews
                state['checks']['publication_workflow'] = cf('inspect original publication outcome', 'workflows', 'instances', 'get', job['id'], '--workflow-name', name)
                state['checks']['app_resource_journal'] = query('SELECT * FROM app_resources')[0]['results']
                save()
                raise RuntimeError('Managed Worker app publication unconfirmed')
            deployed_app = app_previews[0]
            if args.unattended:
                state['demo']['previews'].append(deployed_app); save()
            app_origin = deployed_app['url'].rstrip('/')
            admission = http('/native/pr-preview', {**preview_context, 'action': 'grant', 'previewId': deployed_app['id']}, token=reader)
            redactions.append(admission['grant'])
            exchange = {'previewId': deployed_app['id'], 'email': 'bob@example.invalid', 'method': 'POST', 'path': '__golf/auth', 'origin': url, 'grant': admission['grant'], 'app': True, 'url': app_origin + '/__golf/auth'}
            app_session = preview_rpc(exchange)['session']
            redactions.append(app_session)
            preview_rpc(exchange, expected=404)
            read_app = {'previewId': deployed_app['id'], 'email': 'bob@example.invalid', 'method': 'GET', 'path': 'api/messages', 'app': True,
                'url': app_origin + '/api/messages', 'credential': app_session}
            def app_value(payload):
                result = preview_rpc(payload)
                return json.loads(bytes(result['content']))
            initial = app_value(read_app)
            if initial != {'commit': head, 'messages': [], 'files': 0, 'signing': True}:
                raise RuntimeError('App storage isolation differs')
            written = app_value({**read_app, 'method': 'POST', 'origin': app_origin, 'body': list(b'Private app qualification'), 'headers': {'Content-Type': 'text/plain'}})
            if not hmac.compare_digest(written['signature'], hmac.new(signing_key.encode(), written['receipt'].encode(), hashlib.sha256).hexdigest()):
                raise RuntimeError('Hosted Secrets Store signature differs')
            retained_app = app_value(read_app)
            if retained_app['files'] != 1 or len(retained_app['messages']) != 1 or retained_app['messages'][0]['body'] != 'Private app qualification':
                raise RuntimeError('App D1/R2 readback differs')
            if app_value({**read_app, 'path': 'egress', 'url': app_origin + '/egress'}) != {'status': 403}:
                raise RuntimeError('Application outbound Internet was not denied')
            preview_rpc({**read_app, 'method': 'POST', 'origin': url, 'body': list(b'denied')}, expected=404)
            http('/native/repository-grant', {**grant, 'role': 'none'})
            preview_rpc(read_app, expected=404)
            http('/native/repository-grant', grant)
            state['checks'].update(managed_app=deployed_app, isolated_app_d1_r2=True, hosted_secrets_store_signature=True,
                app_outbound_denied=True, app_grant_replay_denied=True, app_reader_revocation=True)
            save()
        agent_jobs = []
        if args.agents:
            state['checks']['agent_operation_keys'] = []
            for implementation in ['sum((a, b))', 'b + a']:
                agent_request = {'action': 'create', 'selection': selection, 'advice': False, 'idempotencyKey': str(uuid.uuid4()),
                                 'agent': {'prompt': 'Edit calc.py only: implement add(a, b) with return ' + implementation + '. Preserve the function signature. Make this edit now, then finish. Do not read or change tests, run commands, push, merge or deploy.'}}
                state['checks']['agent_operation_keys'].append(agent_request['idempotencyKey'])
                save()
                http('/native/pr-evidence', agent_request, token=reader, expected=404)
                admitted = http('/native/pr-evidence', agent_request)['job']
                if http('/native/pr-evidence', agent_request)['job']['id'] != admitted['id']:
                    raise RuntimeError('Agent admission replay changed identity')
                agent_jobs.append({**inspection, 'jobId': admitted['id']})
            state['checks']['agent_job_ids'] = [a['jobId'] for a in agent_jobs]
            save()
            results = []
            for index, agent_inspection in enumerate(agent_jobs):
                for attempt in range(260):
                    admitted = http('/native/pr-evidence', agent_inspection)['job']
                    if admitted['state'] in ['SUCCEEDED', 'REFUSED', 'EXPIRED']:
                        break
                    time.sleep(1)
                if admitted['state'] != 'SUCCEEDED':
                    raise RuntimeError('Native agent evidence did not complete')
                downloaded_agent = http('/native/pr-evidence', {**agent_inspection, 'action': 'report'}, token=reader)
                result = downloaded_agent['report']['agentResult']
                if result.get('state') != 'succeeded' or result.get('cleanup') != 'destroyed' or result.get('commitId') != head or result.get('treeId') != expected_tree or not result.get('proposalOnly') or result.get('calls', 0) < 1 or result.get('tokens', 0) < 1 or not result.get('patch') or result.get('tests', {}).get('exitCode') != 0 or result.get('deniedRequests', 0) < 1:
                    state['checks']['native_agent_failure'] = result
                    save()
                    raise RuntimeError('Real isolated native agent proposal differs')
                results.append(result)
                retained = directory/f'agent-{index + 1}-evidence.json'
                retained.write_text(json.dumps(downloaded_agent, indent=2) + '\n')
                retained.chmod(0o600)
            rows = query('SELECT id,agent_fork,agent_result FROM evidence_jobs WHERE agent_state=\'succeeded\'')[0]['results']
            records = [json.loads(row['agent_result']) for row in rows]
            if max(r['firstInferenceAt'] for r in records) >= min(r['completedAt'] for r in records):
                raise RuntimeError('Native agent execution did not overlap')
            if len(rows) != 2 or len({row['agent_fork'] for row in rows}) != 2 or len({r['proposalCommitId'] for r in records}) != 2:
                raise RuntimeError('Concurrent agents did not retain independent proposals')
            current_pr = rpc('GetPullRequest', {'repository': key, 'number': pr['number']})['pullRequest']
            if current_pr['head']['commitId'] != head or current_pr['base']['commitId'] != commit:
                raise RuntimeError('Agent proposal changed canonical Git')
            state['checks']['native_agents'] = results
            state['checks']['canonical_unchanged_after_agents'] = True
            save()
        if demo:
            second = rpc('CreateRepository', {'name': 'review-playground', 'description': 'Try PR reviews, CI and protected Worker previews', 'private': True, 'idempotencyKey': str(uuid.uuid4())})['repository']
            git('demo second repository main', '-C', source, 'push', second['cloneUrl'], 'refs/heads/main:refs/heads/main')
            git('demo second repository feature', '-C', source, 'push', second['cloneUrl'], 'refs/heads/feature:refs/heads/feature')
            second_key = {'owner': 'alice', 'name': second['name']}
            second_pull = rpc('CreatePullRequest', {**pull_input, 'repository': second_key, 'repositoryId': second['id'], 'sourceRepository': second_key,
                'sourceRepositoryId': second['id'], 'title': 'Try the Cloudflare collaboration loop', 'idempotencyKey': str(uuid.uuid4())})['pullRequest']
        if registry:
            registry.qualify(http, rpc, repository, tests)
            if args.registry_scanner_image and args.delivery:
                image_digest = tests['image']['digest']
                deployment = {**preview_context, 'action': 'create', 'kind': 'IMAGE_STATIC', 'jobId': job['id'],
                              'imageDigest': image_digest, 'idempotencyKey': str(uuid.uuid4())}
                http('/native/pr-preview', deployment, expected=412)
                initial = registry.package(http, repository, 'settings')
                if registry.package(http, repository, 'policy', reference=image_digest)['allowed']:
                    raise RuntimeError('Vulnerable image unexpectedly passed the original preview policy')
                preview = None
                try:
                    relaxed = {**initial['settings'], 'maxSeverity': 'none'}
                    registry.package(http, repository, 'updateSettings', settings=relaxed, expectedRevision=initial['revision'])
                    if not registry.package(http, repository, 'policy', reference=image_digest)['allowed']:
                        raise RuntimeError('Complete managed scan did not satisfy the explicitly relaxed disposable policy')
                    preview = http('/native/pr-preview', deployment)['preview']
                    if preview['state'] != 'READY' or preview['kind'] != 'IMAGE_STATIC' or preview['imageDigest'] != image_digest or preview['commitId'] != head:
                        raise RuntimeError('Image preview receipt differs from the scanned CI image and tested commit')
                    admission = http('/native/pr-preview', {**preview_context, 'action': 'grant', 'previewId': preview['id']}, token=reader)
                    redactions.append(admission['grant'])
                    exchange = {'previewId': preview['id'], 'email': 'bob@example.invalid', 'method': 'POST', 'path': '__golf/auth',
                                'origin': url, 'grant': admission['grant']}
                    session = preview_rpc(exchange)['session']
                    redactions.append(session)
                    read_image_preview = {'previewId': preview['id'], 'email': 'bob@example.invalid', 'method': 'GET', 'path': '', 'credential': session}
                    actual = preview_rpc(read_image_preview)
                    if actual['content'] != (source/'public/index.html').read_text() or actual['commitId'] != head:
                        raise RuntimeError('Protected preview did not serve the exact image bundle assets')
                finally:
                    current = registry.package(http, repository, 'settings')
                    if current['settings'] != initial['settings']:
                        registry.package(http, repository, 'updateSettings', settings=initial['settings'], expectedRevision=current['revision'])
                if registry.package(http, repository, 'policy', reference=image_digest)['allowed']:
                    raise RuntimeError('Original severity policy did not revoke the image preview')
                preview_rpc(read_image_preview, expected=404)
                http('/native/pr-preview', {**preview_context, 'action': 'grant', 'previewId': preview['id']}, token=reader, expected=404)
                http('/native/pr-preview', {**preview_context, 'action': 'revoke', 'previewId': preview['id']})
                state['checks']['registry_image_preview'] = {'imageDigest': image_digest, 'previewId': preview['id'],
                    'scannedImageServed': True, 'defaultPolicyDenied': True, 'policyChangeRevokedAccess': True}
                save()
        if args.unattended:
            from cloudflare_hosted_check import qualify
            state['checks']['hosted_schema18'] = qualify(http, rpc, git, repository, pr, selection, query, reader, source)
            if args.operations_rehearsal:
                from cloudflare_rehearsal import rehearse
                state['checks']['operations_rehearsal'] = rehearse(directory, args.profile, http, command, preview_context)
            save()
            print(json.dumps({'state': 'machine_browser_ready', 'receipt': str(directory/'ownership.json'), 'deadline': state['demo']['stop_at']}), flush=True)
            for _ in range(120):
                if (directory/'unattended.continue').exists(): break
                time.sleep(1)
        if demo and not args.unattended:
            query('UPDATE users SET email=?,login=? WHERE id=1', [args.demo_email, 'mike'])
            query('INSERT INTO operations_admins(user_id) VALUES(1) ON CONFLICT(user_id) DO UPDATE SET active=1')
            # Rebuild only the gateway; changing the control origin during a live DO deployment is refused.
            build()
            command('production preview gateway deployment', ['cf', '--profile', args.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=directory/'preview-worker', timeout=120)
            for attempt in range(60):
                try:
                    if http('/rpc/golf.v1.SessionService/GetSession')['user']['login'] == 'mike':
                        break
                except RuntimeError:
                    if attempt == 59:
                        raise
                    time.sleep(1)
            state['demo'] = {'url': url, 'repository_ids': [repository['id'], second['id']], 'pull_requests': [pr['number'], second_pull['number']], 'duration_seconds': 14400,
                'begin_command': f'python3 scripts/cloudflare_demo.py begin {directory}/ownership.json', 'stop_command': f'python3 scripts/cloudflare_demo.py stop {directory}/ownership.json'}
            if args.operations_rehearsal:
                from cloudflare_rehearsal import rehearse
                state['checks']['operations_rehearsal'] = rehearse(directory, args.profile, http, command, preview_context)
                save()
            state['state'] = 'awaiting_login'
            save()
            from cloudflare_demo import arm_deadline
            state['demo']['stop_timer'] = arm_deadline(directory/'ownership.json', 1800)
            save()
            print(json.dumps({'state': state['state'], 'url': url, 'receipt': str(directory/'ownership.json'), 'stop': state['demo']['stop_command']}), flush=True)
            signal.alarm(1800)
            from cloudflare_demo import renew_previews
            while True:
                while not (directory/'demo.begin').exists():
                    time.sleep(1)
                try:
                    renewed = renew_previews(http, preview_context)
                    break
                except (RuntimeError, ValueError, KeyError, TypeError):
                    state['demo']['preparation_error'] = 'Preview lease activation was not confirmed; inspect original previews before retrying.'
                    save()
                    state['demo']['stop_timer'] = arm_deadline(directory/'ownership.json', 1800)
                    (directory/'demo.begin').unlink()
                    save(); signal.alarm(1800)
                    print(json.dumps({'state': 'awaiting_login', 'preparation_error': state['demo']['preparation_error']}), flush=True)
            state['state'] = 'ready'
            state['demo']['ready_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
            state['demo'].pop('preparation_error', None)
            state['demo']['previews'] = renewed
            stop_at = min(dt.datetime.fromisoformat(p['expiresAt'].replace('Z', '+00:00')) for p in renewed)
            state['demo']['stop_at'] = stop_at.isoformat()
            seconds = max(1, min(14400, int((stop_at - dt.datetime.now(dt.timezone.utc)).total_seconds())))
            save()
            state['demo']['stop_timer'] = arm_deadline(directory/'ownership.json', seconds)
            save()
            print(json.dumps({'state': 'ready', **state['demo']}), flush=True)
            signal.alarm(seconds)
            while True:
                time.sleep(30)
        (source/'hello.txt').write_text('New push invalidates old approvals and check selections.\n')
        git('stage later native push', '-C', source, 'add', 'hello.txt')
        if args.container_tests:
            (source/'calc.py').write_text('def add(a, b):\n    return a - b\n')
            git('stage deliberate native test failure', '-C', source, 'add', 'calc.py')
        git('commit later native push', '-C', source, 'commit', '-m', 'Invalidate old review')
        next_head = git('later feature identity', '-C', source, 'rev-parse', 'HEAD').stdout.decode().strip()
        git('advance native feature branch', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/feature')
        if args.delivery:
            preview_rpc(read_preview, expected=404)
            http('/native/pr-preview', {**preview_context, 'action': 'grant', 'previewId': protected['id']}, token=reader, expected=404)
            state['checks']['preview_stale_source_denied'] = True
        latest = rpc('GetPullRequest', {'repository': key, 'number': pr['number']})['pullRequest']
        reviews = rpc('ListPullRequestReviews', {'repository': key, 'number': pr['number']})['reviews']
        if latest['head']['commitId'] != next_head or latest['revision'] == pr['revision'] or not reviews[0]['stale']:
            raise RuntimeError('Native push did not invalidate the observed review')
        rpc('CreatePullRequestReview', {**review_input, 'idempotencyKey': str(uuid.uuid4())}, token=reader, expected=412)
        rpc('ListPullRequestChecks', {'selection': selection}, expected=412)
        if rpc('ListPullRequestChecks', {'selection': {**selection, 'headCommitId': next_head}}).get('checks'):
            raise RuntimeError('Old check authority crossed to a new commit')
        if args.evidence:
            if not http('/native/pr-evidence', inspection)['job']['stale']:
                raise RuntimeError('Later push did not stale the evidence')
            http('/native/pr-evidence', {**request, 'idempotencyKey': str(uuid.uuid4())}, expected=412)
            state['checks']['evidence_stale_after_push'] = True
        if args.agents:
            for agent_inspection in agent_jobs:
                if not http('/native/pr-evidence', {**agent_inspection, 'action': 'report'}, token=reader)['job']['stale']:
                    raise RuntimeError('Later push did not stale agent proposal')
        if args.container_tests:
            failed_request = {**request, 'selection': {**selection, 'headCommitId': next_head}, 'advice': False, 'idempotencyKey': str(uuid.uuid4())}
            state['checks']['failed_test_operation_key'] = failed_request['idempotencyKey']
            save()
            if args.ci_resilience:
                candidates = [{**failed_request, 'idempotencyKey': str(uuid.uuid4())} for _ in range(6)]
                with ThreadPoolExecutor(max_workers=6) as pool:
                    allocations = list(pool.map(lambda candidate: http('/native/pr-evidence', candidate, expected=(200, 429)), candidates))
                accepted = [(candidate, result['job']) for candidate, result in zip(candidates, allocations) if 'job' in result]
                if len(accepted) != 1 or sum(result.get('code') == 'resource_exhausted' for result in allocations) != 5:
                    raise RuntimeError('Concurrent final daily slot oversubscribed or returned an untyped refusal')
                failed_request, failed_job = accepted[0]
                state['checks']['failed_test_operation_key'] = failed_request['idempotencyKey']
                state['checks']['concurrent_final_allocation'] = {'requests': 6, 'admitted': 1, 'refused': 5}
                save()
            else:
                failed_job = http('/native/pr-evidence', failed_request)['job']
            failed_inspection = {**inspection, 'jobId': failed_job['id']}
            for attempt in range(240):
                failed_job = http('/native/pr-evidence', failed_inspection)['job']
                if failed_job['state'] in ['SUCCEEDED', 'REFUSED', 'EXPIRED']:
                    break
                time.sleep(1)
            if failed_job['state'] != 'SUCCEEDED':
                raise RuntimeError('Native failure evidence did not finish')
            failed_report = http('/native/pr-evidence', {**failed_inspection, 'action': 'report'}, token=reader)
            tests = failed_report['report']['tests']
            failed_tree = git('exact failing native PR tree', '-C', source, 'rev-parse', 'HEAD^{tree}').stdout.decode().strip()
            if tests['state'] != 'FAILED' or tests['exitCode'] != 1 or tests['cleanup'] != 'destroyed' or tests['commitId'] != next_head or tests['treeId'] != failed_tree or 'FAIL: test_add' not in tests['stderr'] or failed_report['job']['stale']:
                raise RuntimeError('Native failed tests became successful or lost source authority')
            state['checks']['native_failed_tests'] = tests
            state['checks']['failed_test_job_id'] = failed_job['id']
            state['checks']['failed_test_report_sha256'] = failed_job['reportSha256']
            retained = directory/'failed-pr-evidence.json'
            retained.write_text(json.dumps(failed_report, indent=2) + '\n')
            retained.chmod(0o600)
            save()
        if args.ci_resilience:
            with ThreadPoolExecutor(max_workers=6) as pool:
                refusals = list(pool.map(lambda _: http('/native/pr-evidence', {**failed_request, 'idempotencyKey': str(uuid.uuid4())}, expected=429), range(6)))
            if any(result.get('code') != 'resource_exhausted' for result in refusals): raise RuntimeError('Daily allocation refusal was not typed')
            total = query('SELECT count(*) AS n FROM evidence_jobs')[0]['results'][0]['n']
            if total != 3: raise RuntimeError('Daily job allocation oversubscribed')
            if http('/native/pr-evidence', failed_request)['job']['id'] != failed_job['id']: raise RuntimeError('Allocation cap prevented original replay')
            final_cancelled = http('/native/pr-evidence', cancel_selection)['job']
            if final_cancelled['state'] != 'REFUSED' or final_cancelled['testState'] != 'CANCELLED': raise RuntimeError('Delayed workflow resurrected cancellation')
            state['checks']['daily_allocation_cap'] = {'limit': 3, 'allocated': total, 'concurrentRefusals': 6, 'originalReplayAtLimit': True, 'cancelledJobStillTerminal': True}
            save()
        git('authorized reader refs', 'ls-remote', repository['cloneUrl'], token=reader)
        http('/git/alice/canonical.git/info/refs?service=git-receive-pack', method='GET', token=reader, expected=404)
        if not git('reader write denial', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/denied', token=reader, required=False).returncode:
            raise RuntimeError('Reader obtained Git write authority')
        http('/native/repository-grant', {**grant, 'role': 'none'})
        rpc('GetRepository', {'repository': key}, token=reader, expected=404)
        rpc('GetIssue', {'repository': key, 'number': issue['number']}, token=reader, expected=404)
        rpc('GetPullRequest', {'repository': key, 'number': pr['number']}, token=reader, expected=404)
        rpc('GetPullRequestReviewMutation', {'idempotencyKey': review_input['idempotencyKey']}, token=reader, expected=404)
        if args.evidence:
            http('/native/pr-evidence', {**inspection, 'action': 'report'}, token=reader, expected=404)
            if args.container_tests:
                http('/native/pr-evidence', {**failed_inspection, 'action': 'report'}, token=reader, expected=404)
            if args.agents:
                for agent_inspection in agent_jobs:
                    http('/native/pr-evidence', {**agent_inspection, 'action': 'report'}, token=reader, expected=404)
                state['checks']['agent_revoked_reader_denied'] = True
            state['checks']['evidence_reader_revocation'] = True
        http('/git/alice/canonical.git/info/refs?service=git-upload-pack', method='GET', token=reader, expected=404)
        if not git('revoked reader Git denial', 'ls-remote', repository['cloneUrl'], token=reader, required=False).returncode:
            raise RuntimeError('Revoked reader retained Git access')
        state['checks'].update(canonical_commit=commit, create_replay=True, git_push_clone=True,
                               native_cli_read_write=True, native_issue_comment_replay=True, native_revision_cas=True, native_pull_review=True, review_stale_after_push=True, checks_commit_bound=True, collaboration_revocation=True, immutable_file=True, directory_symlink_binary=True, immutable_source_selection=True, repository_reader_revocation=True, unprivileged_write_denied=True)
        state['state'] = 'passed'
        save()
    except DemoFinished as error:
        state['state'] = 'stopped'
        state['demo']['stop_reason'] = str(error)
        save()
    except Exception as error:
        state['state'] = 'failed'
        state['failure'] = str(error)
        save()
    finally:
        signal.alarm(0)
        (directory/'qualification-auth.json').unlink(missing_ok=True)
        cf('cleanup OAuth refresh', 'auth', 'whoami', required=False)
        # Each cleanup has its own command deadline; no broad account deletion.
        def cleanup(label, fn):
            try:
                fn()
                state['cleanup'][label] = 'absent'
            except Exception as error:
                state['cleanup'][label] = 'failed'
                state.setdefault('cleanup_errors', {})[label] = str(error)
            save()

        def absent(label, *arguments):
            for attempt in range(6):
                result = command(label, ['cf', '--profile', args.profile, *map(str, arguments)], required=False)
                if result.returncode and b'404 Not Found' in result.stderr:
                    return
                if attempt < 5: time.sleep(2)
            raise RuntimeError('Provider absence unconfirmed')

        if args.container_tests and state['resources'].get('worker'):
            def stop_tests():
                rows = query('SELECT e.id,e.repository_id,r.name FROM evidence_jobs e JOIN repositories r ON r.id=e.repository_id WHERE e.user_id=1 ', [])[0]['results']
                if len(rows) > evidence_limit:
                    raise RuntimeError('Ambiguous owned test task')
                for job in rows:
                    outcome = http('/native/pr-evidence', {'action': 'cancel', 'jobId': job['id'], 'repository': {'owner': 'alice', 'name': job['name']}, 'repositoryId': str(job['repository_id'])})['job']
                    if outcome['state'] not in ['SUCCEEDED', 'REFUSED', 'EXPIRED'] or outcome['testState'] == 'RUNNING' or outcome.get('agentState') in ['REQUESTED', 'FORK_PENDING', 'RUNNING']:
                        raise RuntimeError('Owned test task did not stop')
            cleanup('test_tasks', stop_tests)

        if args.apps and state['resources'].get('worker'):
            def remove_apps():
                previews = query("SELECT p.id,r.name,p.repository_id FROM previews p JOIN repositories r ON r.id=p.repository_id WHERE p.kind='WORKER' AND p.purged=0")[0]['results']
                if len(previews) > 4:
                    raise RuntimeError('App inventory exceeds owned qualification')
                for p in previews:
                    journal = query('SELECT * FROM app_resources WHERE preview_id=?', [p['id']])[0]['results']
                    state.setdefault('cleanup_app_journal', {})[p['id']] = journal
                    save()
                    http('/native/pr-preview', {'action': 'revoke', 'previewId': p['id'], 'repository': {'owner': 'alice', 'name': p['name']}, 'repositoryId': str(p['repository_id'])})
                    for resource in journal:
                        paths = {'database': '/d1/database/', 'bucket': '/r2/buckets/', 'domain': '/workers/domains/',
                            'script': '/workers/dispatch/namespaces/' + name + '/scripts/', 'cleaner': '/workers/dispatch/namespaces/' + name + '/scripts/'}
                        if resource['kind'] in paths and resource['provider_id']:
                            remaining = provider(prefix + paths[resource['kind']] + resource['provider_id'], expected=(200, 404) if resource['kind'] in ['script', 'cleaner'] else 404)
                            if remaining is not None:
                                raise RuntimeError('Owned app script remains')
                    if any(r['state'] != 'DELETED' for r in query('SELECT * FROM app_resources WHERE preview_id=?', [p['id']])[0]['results']):
                        raise RuntimeError('App resource journal was not retired')
            cleanup('managed_apps', remove_apps)
        for domain_category in ['preview_domain', 'control_domain']:
            if not state['resources'].get(domain_category):
                continue
            def remove_domain(domain_category=domain_category):
                original = state['resources'][domain_category]
                current = provider(prefix + '/workers/domains/' + original['id'])
                if any(current.get(k) != original.get(k) for k in ['id', 'hostname', 'service', 'zone_id']):
                    raise RuntimeError('Preview domain identity changed')
                provider(prefix + '/workers/domains/' + original['id'], 'DELETE')
                provider(prefix + '/workers/domains/' + original['id'], expected=404)
            cleanup(domain_category, remove_domain)

        if state['resources'].get('queue'):
            def detach_consumer():
                original = state['resources']['queue']
                current = cf('owned queue cleanup identity', 'queues', 'get', original['id'])
                if current['queue_name'] != name or current['queue_id'] != original['id']:
                    raise RuntimeError('Queue ownership changed')
                for consumer in current.get('consumers', []):
                    if consumer.get('script') != name or consumer.get('type') != 'worker':
                        raise RuntimeError('Unexpected queue consumer')
                    cf('delete owned queue consumer', 'queues', 'consumers', 'delete', consumer['consumer_id'], '--queue-id', original['id'], '--force')
            cleanup('queue_consumer', detach_consumer)
        if state['resources'].get('workflow') or state.get('workflow_attempted'):
            def remove_workflow():
                probe = command('owned workflow cleanup identity', ['cf', '--profile', args.profile, 'workflows', 'get', name], required=False)
                if probe.returncode and b'404 Not Found' in probe.stderr:
                    return
                if probe.returncode:
                    raise RuntimeError('Owned workflow identity unavailable')
                current = json.loads(probe.stdout)
                if current['script_name'] != name or current['class_name'] != 'EvidenceWorkflow':
                    raise RuntimeError('Workflow ownership changed')
                rows = query('SELECT id FROM evidence_jobs WHERE user_id=1', [])
                for job in rows[0]['results']:
                    job_id = job['id']
                    result = command('owned workflow instance status', ['cf', '--profile', args.profile, 'workflows', 'instances', 'get', job_id, '--workflow-name', name], required=False)
                    if result.returncode and b'404 Not Found' in result.stderr:
                        continue
                    if result.returncode:
                        raise RuntimeError('Workflow instance state unavailable')
                    original = json.loads(result.stdout)
                    if original['status'] not in ['complete', 'errored', 'terminated']:
                        cf('stop owned workflow instance', 'workflows', 'instances', 'terminate', job_id, '--workflow-name', name, '--status', 'terminate', '--force')
                    cf('delete owned workflow instance', 'workflows', 'instances', 'delete', job_id, '--workflow-name', name, '--force')
                cf('delete owned workflow', 'workflows', 'delete', name, '--force')
                absent('workflow absence', 'workflows', 'get', name)
            cleanup('workflow', remove_workflow)

        if state.get('worker_attempted'):
            if registry:
                cleanup('registry_retired', registry.retire)
            if state.get('preview_worker_attempted'):
                def remove_preview_worker():
                    original = state['resources'].get('preview_worker')
                    target = settings['previews']['worker']
                    current = cf('owned preview Worker cleanup identity', 'workers', 'get', target)
                    if current['name'] != target or original and current['id'] != original['id']:
                        raise RuntimeError('Preview Worker ownership changed')
                    cf('delete owned preview Worker', 'workers', 'delete', current['id'], '--force')
                    absent('preview Worker absence', 'workers', 'get', target)
                cleanup('preview_worker', remove_preview_worker)
            def remove_worker():
                probe = command('owned Worker cleanup identity', ['cf', '--profile', args.profile, 'workers', 'get', name], required=False)
                if probe.returncode and b'404 Not Found' in probe.stderr:
                    return
                if probe.returncode:
                    raise RuntimeError('Owned Worker cleanup identity unavailable')
                current = json.loads(probe.stdout)
                if current['name'] != name:
                    raise RuntimeError('Worker ownership changed')
                build('retire')
                command('retire owned workspace class', ['cf', '--profile', args.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=directory, timeout=120)
                cf('delete owned Worker', 'workers', 'delete', current['id'], '--force')
                result = command('Worker absence', ['cf', '--profile', args.profile, 'workers', 'get', name], required=False)
                if not result.returncode or b'404 Not Found' not in result.stderr:
                    raise RuntimeError('Worker absence unconfirmed')
            cleanup('worker', remove_worker)
            def verify_namespaces():
                namespaces = cf('owned Durable Object namespace absence', 'durable-objects', 'namespaces', 'list', '--per-page', '100')
                if not isinstance(namespaces, list) or len(namespaces) >= 100 or any(not isinstance(n.get('script'), str) or n['script'] == name for n in namespaces):
                    raise RuntimeError('Owned Durable Object namespace remains or inventory is ambiguous')
            cleanup('durable_object_namespaces', verify_namespaces)
        if registry:
            cleanup('registry_resources', registry.remove)
        if args.apps and state.get('app_outbound_attempted'):
            def remove_outbound():
                original = state['resources'].get('app_outbound')
                target = name + '-outbound'
                current = cf('outbound Worker cleanup identity', 'workers', 'get', target)
                if current['name'] != target or original and current['id'] != original['id']:
                    raise RuntimeError('Outbound Worker identity changed')
                cf('delete owned outbound Worker', 'workers', 'delete', current['id'], '--force')
                absent('outbound Worker absence', 'workers', 'get', target)
            cleanup('app_outbound', remove_outbound)
        if state['resources'].get('dispatch'):
            def remove_dispatch():
                original = state['resources']['dispatch']
                current = cf('dispatch identity readback', 'workers-for-platforms', 'dispatch-namespaces', 'get', name)
                if current['namespace_id'] != original['namespace_id']:
                    raise RuntimeError('Dispatch namespace identity changed')
                if provider(prefix + '/workers/dispatch/namespaces/' + name + '/scripts'):
                    raise RuntimeError('Dispatch namespace still contains app scripts')
                cf('delete owned empty dispatch', 'workers-for-platforms', 'dispatch-namespaces', 'delete', name, '--force')
                absent('dispatch namespace absence', 'workers-for-platforms', 'dispatch-namespaces', 'get', name)
            cleanup('dispatch', remove_dispatch)
        if state['resources'].get('test_image'):
            def remove_applications():
                for target in [name] + ([name + '-agents'] if args.agents else []):
                    applications = cf('owned container application inventory', 'containers', 'applications', 'list', '--name', target, '--per-page', '10')
                    if len(applications) >= 10 or any(app['name'] != target for app in applications):
                        raise RuntimeError('Ambiguous container ownership')
                    for app in applications:
                        cf('delete owned container application', 'containers', 'applications', 'delete', app['id'], '--force')
                    if cf('container application absence', 'containers', 'applications', 'list', '--name', target, '--per-page', '10'):
                        raise RuntimeError('Container application remains')
            cleanup('test_applications', remove_applications)
            def remove_image():
                image = state['resources']['test_image']['tag']
                cf('delete owned test image', 'containers', 'images', 'delete', image, '--force', required=False)
                if cf('test image absence', 'containers', 'images', 'list', '--filter', '^' + re.escape(name) + '$'):
                    raise RuntimeError('Test image remains')
                command('remove owned local image tag', ['docker', 'image', 'rm', image], required=False)
            cleanup('test_image', remove_image)
        if state['resources'].get('queue'):
            def remove_queue():
                original = state['resources']['queue']
                current = cf('owned queue cleanup identity', 'queues', 'get', original['id'])
                if current['queue_name'] != name or current['queue_id'] != original['id']:
                    raise RuntimeError('Queue ownership changed')
                if current.get('consumers'):
                    raise RuntimeError('Queue still has consumers')
                cf('delete owned queue', 'queues', 'delete', original['id'], '--force')
                absent('queue absence', 'queues', 'get', original['id'])
            cleanup('queue', remove_queue)
        if state['resources'].get('gateway'):
            def remove_gateway():
                if cf('owned gateway cleanup identity', 'ai-gateway', 'gateways', 'get', name)['id'] != name:
                    raise RuntimeError('Gateway ownership changed')
                cf('delete owned gateway', 'ai-gateway', 'gateways', 'delete', name, '--force')
                absent('gateway absence', 'ai-gateway', 'gateways', 'get', name)
            cleanup('gateway', remove_gateway)
        if state['resources'].get('bucket'):
            def remove_bucket():
                current = cf('owned bucket cleanup identity', 'r2', 'buckets', 'get', name)
                if current['name'] != name or current['creation_date'] != state['resources']['bucket']['creation_date']:
                    raise RuntimeError('Bucket ownership changed')
                objects = cf('owned evidence object inventory', 'r2', 'objects', 'list', '--bucket-name', name, '--per-page', '1000')
                keys = [obj['key'] for obj in objects]
                rows = query('SELECT id,repository_id,report_key FROM evidence_jobs WHERE user_id=1', [])
                expected = []
                for job in rows[0]['results']:
                    key = job['report_key']
                    if key:
                        prefix = f"pr-evidence/alice/{job['repository_id']}/{job['id']}/"
                        if not key.startswith(prefix) or not re.fullmatch('[a-f0-9]{64}\\.json', key.removeprefix(prefix)):
                            raise RuntimeError('Unexpected durable evidence key')
                        expected.append(key)
                if args.delivery:
                    previews = query('SELECT id,bundle_key,bundle_hash,capture_key FROM previews', [])[0]['results']
                    if len(previews) > 4:
                        raise RuntimeError('Ambiguous preview object inventory')
                    for preview in previews:
                        prefix = f"native-previews/alice/{preview['id']}/"
                        if preview['bundle_key'] != prefix + preview['bundle_hash'] + '.json' or preview['capture_key'] not in [None, prefix + 'snapshot.png']:
                            raise RuntimeError('Preview object ownership differs')
                        expected.extend([k for k in [preview['bundle_key'], preview['capture_key']] if k])
                from cloudflare_demo_cleanup import retained_assets, index_inventory
                indexes = index_inventory(query('SELECT key,payload_hash,payload_bytes FROM repository_indexes')[0]['results'])
                assets = retained_assets(directory, args.account_id, name)
                expected.extend(indexes)
                expected.extend(assets)
                # Persist exact owned storage before retiring its authority journal.
                state['cleanup_storage'] = {'indexes': indexes, 'assets': assets, 'objects': objects}
                save()
                for obj in objects:
                    record = assets.get(obj['key']) or indexes.get(obj['key'])
                    if record and (obj['size'] != record['bytes'] or 'etag' in record and obj['etag'].strip('"') != record['etag']):
                        raise RuntimeError('Retained storage identity differs')
                if len(keys) >= 1000 or not set(keys) <= set(expected):
                    raise RuntimeError('Unexpected evidence bucket inventory')
                for key in keys:
                    cf('delete owned evidence object', 'r2', 'objects', 'delete', key, '--bucket-name', name, '--force')
                cf('delete owned evidence bucket', 'r2', 'buckets', 'delete', name, '--force')
                absent('bucket absence', 'r2', 'buckets', 'get', name)
            cleanup('bucket', remove_bucket)
        for category, resource in [('preview_access', ['zero-trust', 'access', 'applications']), ('control_access', ['zero-trust', 'access', 'applications']), ('preview_service_token', ['zero-trust', 'access', 'service-tokens']), ('demo_idp', ['zero-trust', 'identity-providers'])]:
            if state['resources'].get(category):
                def remove_access(category=category, resource=resource):
                    original = state['resources'][category]
                    current = cf('owned preview Access cleanup identity', *resource, 'get', original['id'])
                    if current['id'] != original['id'] or current['name'] != original['name']:
                        raise RuntimeError('Preview Access ownership changed')
                    cf('delete owned preview Access resource', *resource, 'delete', original['id'], '--force')
                    absent('preview Access absence', *resource, 'get', original['id'])
                cleanup(category, remove_access)
        if state['resources'].get('namespace'):
            def remove_namespace():
                result = cf('owned repository inventory', 'artifacts', 'namespaces', 'repos', 'list', '--namespace', name, '--limit', '100')
                rows = result.get('repos') if isinstance(result, dict) else result
                if not isinstance(rows, list) or len(rows) >= 100 or any(not re.fullmatch('repo-[a-f0-9]{32}', r['name']) for r in rows):
                    raise RuntimeError('Unexpected owned namespace inventory')
                for row in rows:
                    cf('delete owned repository', 'artifacts', 'namespaces', 'repos', 'delete', row['name'], '--namespace', name, '--force')
                cf('delete owned namespace', 'artifacts', 'namespaces', 'delete', name, '--force')
                result = command('namespace absence', ['cf', '--profile', args.profile, 'artifacts', 'namespaces', 'get', name], required=False)
                if not result.returncode or b'404 Not Found' not in result.stderr:
                    raise RuntimeError('Namespace absence unconfirmed')
            cleanup('namespace', remove_namespace)
        if state['resources'].get('database'):
            def remove_database():
                if state['resources'].get('bucket') and state['cleanup'].get('bucket') != 'absent':
                    raise RuntimeError('Keep the storage authority journal until bucket cleanup is confirmed')
                original = state['resources']['database']
                current = cf('owned database identity', 'd1', 'get', original['uuid'])
                if current['uuid'] != original['uuid'] or current['name'] != name:
                    raise RuntimeError('Database ownership changed')
                cf('delete owned database', 'd1', 'delete', original['uuid'], '--force')
                result = command('database absence', ['cf', '--profile', args.profile, 'd1', 'get', original['uuid']], required=False)
                if not result.returncode or b'404 Not Found' not in result.stderr:
                    raise RuntimeError('Database absence unconfirmed')
            cleanup('database', remove_database)
        if state['resources'].get('secret_store'):
            def remove_store():
                original = state['resources']['secret_store']
                path = prefix + '/secrets_store/stores/' + original['id']
                current = provider(path)
                if current.get('id') != original['id'] or current.get('name') != original['name']:
                    raise RuntimeError('Secrets Store identity changed')
                current_secrets = provider(path + '/secrets')
                acknowledged = {(s['id'], s['name']) for s in state['resources'].get('secrets', [])}
                if not {(s['id'], s['name']) for s in current_secrets} <= acknowledged:
                    raise RuntimeError('Secret inventory differs; deletion refused')
                for s in current_secrets:
                    provider(path + '/secrets/' + s['id'], 'DELETE', expected=(200, 202))
                provider(path, 'DELETE', expected=(200, 202))
                for attempt in range(20):
                    if provider(path, expected=(200, 404)) is None:
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError('Secrets Store removal still pending')
            cleanup('secret_store', remove_store)
        if management:
            def remove_management():
                user = cf('cleanup operator identity', 'user', 'get')
                selected = [g for g in groups if g['name'] in ['API Tokens Read', 'API Tokens Write'] and g.get('is_selectable')]
                if len(selected) != 2:
                    raise RuntimeError('Token cleanup permissions unavailable')
                policy = [{'effect': 'allow', 'resources': {'com.cloudflare.api.user.' + user['id']: '*'}, 'permission_groups': [{'id': g['id']} for g in selected]}]
                expiry = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%SZ')
                revoker = cf('five-minute exact token cleanup credential', 'user', 'tokens', 'create', '--name', name + '-cleanup', '--expires-on', expiry, '--policies', json.dumps(policy))
                redactions.append(revoker['value'])
                state['resources']['cleanup_token'] = {'id': revoker['id'], 'expires_at': expiry}
                save()
                try:
                    provider('/user/tokens/' + management['id'], 'DELETE', token=revoker['value'])
                    provider('/user/tokens/' + management['id'], expected=404, token=revoker['value'])
                    if analytics:
                        provider('/user/tokens/' + analytics['id'], 'DELETE', token=revoker['value'])
                        provider('/user/tokens/' + analytics['id'], expected=404, token=revoker['value'])
                        state['cleanup']['analytics_token'] = 'absent'
                finally:
                    provider('/user/tokens/' + revoker['id'], 'DELETE', token=revoker['value'])
                state['cleanup']['cleanup_token'] = 'absent'
            cleanup('management_token', remove_management)
        state['finished_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
        save()
    print(json.dumps({'state': state['state'], 'receipt': str(directory/'ownership.json'), 'cleanup': state['cleanup']}))
    expected = ['worker', 'namespace', 'database'] + (['workflow', 'queue', 'bucket'] if args.evidence else []) + (['gateway'] if args.evidence_ai else [])
    if args.evidence:
        expected += ['queue_consumer']
    if args.delivery:
        expected += ['preview_worker', 'preview_access', 'preview_service_token']
    if args.container_tests:
        expected += ['test_tasks', 'test_applications', 'test_image', 'durable_object_namespaces']
    if args.apps:
        expected += ['managed_apps', 'app_outbound', 'preview_domain', 'dispatch', 'secret_store', 'management_token', 'cleanup_token']
    if demo:
        expected += ['control_access', 'control_domain']
        if not args.unattended: expected += ['demo_idp']
    if args.operations_rehearsal:
        expected += ['analytics_token']
    if args.registry_host:
        expected += ['registry_retired', 'registry_resources']
    removed = all(state['cleanup'].get(key) == 'absent' for key in expected) and all(value == 'absent' for value in state['cleanup'].values())
    if removed and state.get('demo', {}).get('stop_timer'):
        command('cancel completed cleanup timer', ['systemctl', '--user', 'stop', state['demo']['stop_timer'] + '.timer'])
    return 0 if state['state'] in ['passed', 'stopped'] and removed else 1


if __name__ == '__main__':
    raise SystemExit(main())
