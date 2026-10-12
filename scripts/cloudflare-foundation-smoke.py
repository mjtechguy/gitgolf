#!/usr/bin/env python3
"""Disposable live Worker/R2/Artifacts proof. Uses cf OAuth; never reads its keys."""
import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = Path(__file__).resolve().parent.parent
SOURCE = 'https://github.com/octocat/Hello-World.git'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--agents', action='store_true', help='Also qualify native Cloudflare concurrent agent tasks')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{32}', args.account_id) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,62}', args.profile):
        parser.error('canonical account ID and named profile required')
    if any(os.getenv(k) for k in ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_EMAIL']):
        parser.error('remove environment credential overrides before using the named profile')
    name = 'golf-cf1-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d') + '-' + secrets.token_hex(4)
    root = REPO / '.tmp/cloudflare-foundation' / name
    root.mkdir(mode=0o700, parents=True)
    env = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': args.account_id, 'CF_SEND_TELEMETRY': 'false', 'CI': 'true'}
    state = {'schema_version': 'golf.cloudflare.foundation-live.v1', 'run': name, 'account': args.account_id,
             'profile': args.profile, 'resources': {'worker': name, 'bucket': name, 'namespace': name},
             'daily_testing_budget_usd': 10, 'public_probe': True, 'events': [], 'checks': {}, 'cleanup': {}, 'state': 'running'}
    state['source_sha256'] = {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__).resolve(), REPO / 'cloudflare/qualification/prepare.mjs', REPO / 'cloudflare/qualification/src/worker.mjs', REPO / 'internal/objectstore/cloudflare_test.go', REPO / 'internal/objectstore/s3.go']}
    token_ids, revoked_ids, repositories, object_keys, automatic_tokens = [], [], [], [], []
    r2_token_id = None
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def save():
        path = root / 'ownership.json'
        path.write_text(json.dumps(state, indent=2) + '\n')
        path.chmod(0o600)

    def command(label, argv, *, environment=env, cwd=REPO, required=True, timeout=45):
        start = time.monotonic()
        with subprocess.Popen(argv, cwd=cwd, env=environment, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                # Stop this command's descendants too (notably native Docker push).
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                state['events'].append({'operation': label, 'state': 'timeout'})
                save()
                raise RuntimeError(label + ' timed out') from None
            p = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
        error_status = re.search(rb'\b(\d{3}) (?:Forbidden|Unauthorized|Not Found|Conflict|Bad Request)', p.stderr)
        state['events'].append({'operation': label, 'exit_code': p.returncode, 'seconds': round(time.monotonic() - start, 3),
                                'error_http_status': int(error_status[1]) if error_status else None})
        save()
        if required and p.returncode:
            raise RuntimeError(label + ' failed; diagnostic content withheld')
        return p

    def cf(label, *argv, required=True):
        p = command(label, ['cf', '--profile', args.profile, *argv], required=required)
        return json.loads(p.stdout) if p.returncode == 0 and p.stdout.strip() else None

    def git(label, *argv, token=None, required=True):
        # A fresh environment suppresses ambient credentials, rewrites, proxies,
        # hooks, traces and prompts. Secret headers exist only in child env.
        git_env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
                   'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull, 'GIT_TERMINAL_PROMPT': '0'}
        config = {'credential.helper': '', 'core.hooksPath': os.devnull, 'http.followRedirects': 'false',
                  'http.proxy': '', 'http.sslVerify': 'true', 'user.name': 'Golf qualification', 'user.email': 'qualification@example.invalid'}
        if token:
            # Credentials are opaque. Admit bounded printable ASCII only, so
            # a provider format change cannot inject another HTTP header.
            if not isinstance(token, str) or not 32 <= len(token) <= 2048 or re.search(r'[^\x21-\x7e]', token):
                raise RuntimeError('unexpected scoped Git credential format')
            config['http.extraHeader'] = 'Authorization: Bearer ' + token
        git_env['GIT_CONFIG_COUNT'] = str(len(config))
        for i, (key, value) in enumerate(config.items()):
            git_env[f'GIT_CONFIG_KEY_{i}'], git_env[f'GIT_CONFIG_VALUE_{i}'] = key, value
        return command(label, ['git', *map(str, argv)], environment=git_env, required=required)

    def remote(metadata):
        value = metadata['remote']
        u = urllib.parse.urlsplit(value)
        expected = f'https://{args.account_id}.artifacts.cloudflare.net/git/{name}/{metadata["name"]}.git'
        if value != expected or u.username or u.query or u.fragment:
            raise RuntimeError('unexpected Artifacts credential destination')
        return value

    def mint(repo, scope):
        data = cf('mint ' + scope + ' token for ' + repo, 'artifacts', 'namespaces', 'tokens', 'create', name,
                  '--repo', repo, '--scope', scope, '--ttl', '900')
        token_ids.append(data['id'])
        state['git_token_ids'] = token_ids.copy()
        save()
        return data

    def http(url, *, token=None, method='GET'):
        headers = {'User-Agent': 'GolfCloudflareQualification/1.0', 'Accept': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(url, headers=headers, method=method)
        try:
            response = client.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(16385)
            if len(body) > 16384:
                raise RuntimeError('qualification HTTP response exceeds bound')
            return response.status, body, response.headers

    def delete_objects():
        if not object_keys:
            return
        actual = cf('owned R2 object inventory', 'r2', 'objects', 'list', '--bucket-name', name, '--per-page', '100')
        keys = [item['key'] for item in actual]
        if len(keys) >= 100 or not set(keys) <= set(object_keys):
            raise RuntimeError('unexpected object in owned qualification bucket')
        if keys:
            cf('owned R2 objects delete', 'r2', 'objects', 'bulk-delete', '--bucket-name', name, '--body', json.dumps(keys), '--force')

    try:
        identity = cf('profile identity', 'auth', 'whoami')
        if not identity.get('authenticated') or not identity.get('tokenValid') or not identity.get('authSource', '').startswith('OAuth token from ') or not identity['authSource'].endswith('/' + args.profile + '.json') or args.account_id not in [a['id'] for a in identity['accounts']]:
            raise RuntimeError('selected OAuth profile/account not qualified')
        groups = cf('R2 permission inventory', 'user', 'tokens', 'permission-groups', 'list')
        group = next(g for g in groups if g['name'] == 'Workers R2 Storage Bucket Item Write' and g.get('is_selectable'))
        for label, argv in [('worker', ['workers', 'get', name]), ('bucket', ['r2', 'buckets', 'get', name]), ('namespace', ['artifacts', 'namespaces', 'get', name])]:
            p = command('fresh target ' + label, ['cf', '--profile', args.profile, *argv], required=False)
            if p.returncode == 0 or b'404 Not Found' not in p.stderr:
                raise RuntimeError('fresh resource target could not be confirmed absent')
        state['bucket_creation_attempted'] = True
        save()
        cf('owned bucket create', 'r2', 'buckets', 'create', '--name', name)
        state['bucket_created'] = True
        save()
        state['namespace_creation_attempted'] = True
        save()
        cf('owned namespace create', 'artifacts', 'namespaces', 'create', '--namespace', name)
        state['namespace_created'] = True
        save()
        managed = cf('public R2 domain check', 'r2', 'buckets', 'domains', 'managed', 'list', '--bucket-name', name)
        custom = cf('custom R2 domains check', 'r2', 'buckets', 'domains', 'custom', 'list', '--bucket-name', name)
        if managed['enabled'] or custom['domains']:
            raise RuntimeError('owned R2 bucket is publicly routed')
        state['checks']['r2_public_domains_disabled'] = True
        expiry = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
        policies = [{'effect': 'allow', 'resources': {f'com.cloudflare.edge.r2.bucket.{args.account_id}_default_{name}': '*'}, 'permission_groups': [{'id': group['id']}]}]
        parent = cf('bucket-scoped R2 credential create', 'user', 'tokens', 'create', '--name', name,
                    '--expires-on', expiry, '--policies', json.dumps(policies))
        r2_token_id = parent['id']
        state['r2_token_id'] = r2_token_id
        save()
        fixture = io.BytesIO()
        with tarfile.open(fileobj=fixture, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            data = b'Golf Cloudflare foundation fixture\n'
            item = tarfile.TarInfo('README.md')
            item.size, item.mode = len(data), 0o644
            archive.addfile(item, io.BytesIO(data))
        (root / 'source.tar').write_bytes(fixture.getvalue())
        state['object_key'] = 'ci-sources/' + hashlib.sha256(fixture.getvalue()).hexdigest() + '.tar'
        save()
        live_env = {**env, 'GOLF_R2_LIVE_QUALIFICATION': '1', 'GOLF_R2_LIVE_ACCOUNT_ID': args.account_id,
                    'GOLF_R2_LIVE_BUCKET': name, 'GOLF_R2_LIVE_ACCESS_KEY_ID': r2_token_id,
                    'GOLF_R2_LIVE_SECRET_ACCESS_KEY': hashlib.sha256(parent['value'].encode()).hexdigest(),
                    'GOLF_R2_LIVE_FIXTURE': str(root / 'source.tar'), 'GOLF_R2_LIVE_RECEIPT': str(root / 'r2-live.json')}
        try:
            checked = command('real Golf R2 store qualification', ['go', 'test', './internal/objectstore', '-run', '^TestCloudflareR2Live$', '-count=1', '-v', '-timeout', '4m'], environment=live_env, timeout=250, required=False)
            # This maintained test prints fixed assertions and sanitized Store
            # errors, never credentials, provider bodies or object contents.
            (root / 'r2-live-check.log').write_bytes(checked.stdout + checked.stderr)
            if checked.returncode:
                raise RuntimeError('real Golf R2 store qualification failed')
        finally:
            if (root / 'r2-live.json').exists():
                result = json.loads((root / 'r2-live.json').read_text())
                object_keys[:] = result['object_keys']
                state['object_keys'] = object_keys.copy()
                save()
        if result['state'] != 'passed':
            raise RuntimeError('native R2 qualification did not pass')
        state['checks']['golf_r2_store'] = result
        git('independent public baseline clone', 'clone', '--depth', '1', '--branch', 'master', SOURCE, root / 'public-baseline')
        base = git('public baseline commit', '-C', root / 'public-baseline', 'rev-parse', 'HEAD').stdout.decode().strip()
        tree = git('public baseline tree', '-C', root / 'public-baseline', 'rev-parse', 'HEAD^{tree}').stdout.decode().strip()
        # Journal deterministic targets before writes, including ambiguous replies.
        repositories.append('baseline')
        state['repositories'] = repositories.copy()
        save()
        baseline = cf('Artifacts public import', 'artifacts', 'namespaces', 'repos', 'import', 'baseline', '--namespace', name,
                      '--url', SOURCE, '--branch', 'master', '--depth', '1')
        baseline_remote = remote(baseline)
        automatic_tokens.append((baseline_remote, baseline['token']))
        git('automatic import credential usable before deletion', 'ls-remote', baseline_remote, token=baseline['token'])
        reader = mint('baseline', 'read')
        git('imported baseline clone', 'clone', '--depth', '1', '--branch', 'master', baseline_remote, root / 'imported', token=reader['plaintext'])
        for revision, expected in [('HEAD', base), ('HEAD^{tree}', tree)]:
            if git('verify imported ' + revision, '-C', root / 'imported', 'rev-parse', revision).stdout.decode().strip() != expected:
                raise RuntimeError('import differs from independently observed baseline')
        source_head = git('recheck public baseline', 'ls-remote', SOURCE, 'refs/heads/master').stdout.decode().split()[0]
        if source_head != base:
            raise RuntimeError('public source advanced during import')
        state['checks']['import'] = {'source': SOURCE, 'depth': 1, 'commit': base, 'tree': tree, 'repository_id': baseline['id']}
        status, _, _ = http(baseline_remote + '/info/refs?service=git-upload-pack')
        if status not in (401, 403) or git('anonymous Git denied', 'ls-remote', baseline_remote, required=False).returncode == 0:
            raise RuntimeError('private Git allowed anonymous access')
        repositories.append('proposal')
        state['repositories'] = repositories.copy()
        save()
        # Use the installed native SDK's extra body field for the beta CLI defect.
        fork = json.loads(command('Artifacts fork', ['node', 'cloudflare/qualification/prepare.mjs', str(root), shutil.which('cf'), 'fork']).stdout)
        if fork['name'] != 'proposal':
            raise RuntimeError('fork destination differs from owned target')
        state['repositories'] = repositories.copy()
        save()
        fork_remote = remote(fork)
        automatic_tokens.append((fork_remote, fork['token']))
        git('automatic fork credential usable before deletion', 'ls-remote', fork_remote, token=fork['token'])
        writer = mint(fork['name'], 'write')
        git('independent fork clone', 'clone', '--depth', '1', '--branch', 'master', fork_remote, root / 'fork', token=writer['plaintext'])
        if git('fork starting commit', '-C', root / 'fork', 'rev-parse', 'HEAD').stdout.decode().strip() != base:
            raise RuntimeError('fork did not start at the verified baseline')
        (root / 'fork/qualification.txt').write_text('Independent Golf Artifacts proposal\n')
        git('proposal add', '-C', root / 'fork', 'add', 'qualification.txt')
        git('proposal commit', '-C', root / 'fork', 'commit', '-m', 'Golf CF1 qualification')
        candidate = git('proposal commit identity', '-C', root / 'fork', 'rev-parse', 'HEAD').stdout.decode().strip()
        candidate_tree = git('proposal tree identity', '-C', root / 'fork', 'rev-parse', 'HEAD^{tree}').stdout.decode().strip()
        git('scoped fork push', '-C', root / 'fork', 'push', fork_remote, 'HEAD:refs/heads/master', token=writer['plaintext'])
        verifier = mint(fork['name'], 'read')
        git('fresh proposal verification clone', 'clone', '--depth', '1', '--branch', 'master', fork_remote, root / 'verified', token=verifier['plaintext'])
        for revision, expected in [('HEAD', candidate), ('HEAD^{tree}', candidate_tree)]:
            if git('verify proposal ' + revision, '-C', root / 'verified', 'rev-parse', revision).stdout.decode().strip() != expected:
                raise RuntimeError('remote proposal identity differs from pushed commit/tree')
        denied = git('read token cannot push', '-C', root / 'fork', 'push', baseline_remote, 'HEAD:refs/heads/denied', token=reader['plaintext'], required=False)
        if denied.returncode == 0 or not re.search(rb'(?:returned error: (?:401|403)|Authentication failed)', denied.stderr):
            raise RuntimeError('read token write denial not observed')
        cross_status, _, _ = http(fork_remote + '/info/refs?service=git-upload-pack', token=reader['plaintext'])
        if cross_status not in (401, 403) or git('baseline token cannot read fork', 'ls-remote', fork_remote, token=reader['plaintext'], required=False).returncode == 0:
            raise RuntimeError('repository token crossed its scope')
        refs = git('verify unchanged parent refs', 'ls-remote', baseline_remote, token=reader['plaintext']).stdout.decode()
        if base + '\trefs/heads/master' not in refs or 'refs/heads/denied' in refs:
            raise RuntimeError('fork or denied write changed parent repository')
        cf('revoke baseline reader', 'artifacts', 'namespaces', 'tokens', 'revoke', reader['id'], '--namespace', name, '--force')
        revoked_ids.append(reader['id'])
        revoked_status, _, _ = http(baseline_remote + '/info/refs?service=git-upload-pack', token=reader['plaintext'])
        if revoked_status not in (401, 403) or git('revoked Git token denied', 'ls-remote', baseline_remote, token=reader['plaintext'], required=False).returncode == 0:
            raise RuntimeError('revoked repository credential still admitted a new request')
        state['checks']['git'] = {'fork_id': fork['id'], 'fork_name': fork['name'], 'base_commit': base,
                                 'proposal_commit': candidate, 'proposal_tree': candidate_tree,
                                 'anonymous_status': status, 'read_write_denied': True, 'cross_repo_denied': True,
                                 'cross_repo_http_status': cross_status, 'revoked_http_status': revoked_status,
                                 'revoked_token_denied': True, 'parent_unchanged': True}
        command('native cf build output', ['node', 'cloudflare/qualification/prepare.mjs', str(root), shutil.which('cf')])
        secret = secrets.token_urlsafe(32)
        secret_file = root / 'probe-secret.json'
        secret_file.write_text(json.dumps({'GOLF_PROBE_TOKEN': secret}))
        secret_file.chmod(0o600)
        try:
            state['worker_creation_attempted'] = True
            save()
            deployed = command('Worker deploy', ['cf', '--profile', args.profile, 'deploy', '--prebuilt', '--provision', 'false', '--secrets-file', str(secret_file)], cwd=root, timeout=120)
        finally:
            secret_file.unlink(missing_ok=True)
        urls = re.findall(rb'https://[^\s]+\.workers\.dev', deployed.stdout)
        if len(urls) != 1:
            raise RuntimeError('deployment did not identify one Worker URL')
        url = urls[0].decode()
        metadata = cf('deployed Worker readback', 'workers', 'get', name)
        if metadata['name'] != name or metadata['subdomain']['url'] != url or metadata['subdomain']['previews_enabled']:
            raise RuntimeError('Worker deployment identity or preview policy differs')
        versions = re.findall(rb'Current Version ID: ([a-f0-9-]{36})', deployed.stdout)
        started = time.monotonic()
        platform_404s = 0
        def worker_http(path, token, method):
            nonlocal platform_404s
            while True:
                response = http(url + path, token=token, method=method)
                status, body, _ = response
                result = json.loads(body)
                # Only retry the platform404, never a Worker refusal/failure.
                # All methods here are side-effect-free in this exact probe.
                missing_script = result.get('cloudflare_error') is True and (
                    (status == 404 and result.get('error_code') == 1042) or
                    (status == 500 and result.get('error_code') == 1104))
                if not missing_script:
                    return response
                platform_404s += int(status == 404)
                state['checks']['worker_platform_404s'] = platform_404s
                if status == 500:
                    state['checks']['worker_script_missing_1104s'] = state['checks'].get('worker_script_missing_1104s', 0) + 1
                save()
                if time.monotonic() - started >= 30:
                    raise RuntimeError('fresh Worker script did not become ready')
                time.sleep(0.5)
        checks = []
        for label, path, token, method, expected in [('anonymous', '/inspect', None, 'GET', 401),
                ('wrong token', '/inspect', 'x' * 43, 'GET', 401), ('real bindings', '/inspect', secret, 'GET', 200),
                ('write method', '/inspect', secret, 'POST', 405), ('query', '/inspect?extra=1', secret, 'GET', 404)]:
            status, body, headers = worker_http(path, token, method)
            result = json.loads(body)
            if status != expected or 'no-store' not in [directive.strip() for directive in (headers.get('Cache-Control') or '').lower().split(',')]:
                state['checks']['worker_boundary_failure'] = {'check': label, 'http_status': status,
                    'cache_control': headers.get('Cache-Control'), 'response_state': result.get('state'),
                    'provider_error_codes': [e.get('code') for e in result.get('errors', []) if isinstance(e, dict)],
                    'diagnostic': body.decode(errors='replace').replace(secret, '[withheld]')[:4096]}
                save()
                raise RuntimeError('Worker ' + label + ' did not satisfy its boundary')
            if expected == 200 and (result.get('schema_version') != 'golf.cloudflare.binding-inspection.v1' or len(result.get('observations', [])) != 2 or any(o.get('state') != 'accessible' for o in result['observations'])):
                raise RuntimeError('real Worker bindings did not succeed')
            if secret.encode() in body or name.encode() in body or b'qualification.txt' in body:
                raise RuntimeError('Worker disclosed credentials or private metadata')
            checks.append({'check': label, 'http_status': status, 'response': result})
        state['checks']['worker_checks_ms'] = round((time.monotonic() - started) * 1000)
        state['checks']['worker'] = {'id': metadata['id'], 'url': url, 'version_id': versions[0].decode() if versions else None, 'requests': checks}
        if args.agents:
            from cloudflare_agents import qualify_agents
            qualify_agents(root, state, save, command, cf, git, mint, automatic_tokens, object_keys)
        state['state'] = 'passed'
    except Exception as error:
        state['state'] = 'failed'
        # Exceptions contain only our fixed messages; never CLI output or keys.
        state['failure'] = type(error).__name__ + ': ' + (str(error) if isinstance(error, RuntimeError) else 'qualification operation failed')
    finally:
        if state.get('namespace_creation_attempted'):
            try:
                actual = cf('reconcile owned repositories', 'artifacts', 'namespaces', 'repos', 'list', '--namespace', name, '--limit', '100')
                if len(actual) >= 100:
                    raise RuntimeError('owned repository inventory exceeds qualification bounds')
                repositories[:] = [repo['name'] for repo in actual]
                state['repositories'] = repositories.copy()
            except Exception:
                state['cleanup']['repository_reconciliation'] = 'failed'
        # Every delete is exact-owned. No force-with-references or broad bucket purge.
        for label, operation in [
            ('worker', lambda: cf('owned Worker delete', 'workers', 'delete', name, '--force', required=False) if state.get('worker_creation_attempted') else None),
            *[('git_token_' + tid, lambda tid=tid: cf('revoke owned Git token', 'artifacts', 'namespaces', 'tokens', 'revoke', tid, '--namespace', name, '--force')) for tid in token_ids if tid not in revoked_ids],
            *[(repo, lambda repo=repo: cf('owned repo delete', 'artifacts', 'namespaces', 'repos', 'delete', repo, '--namespace', name, '--force')) for repo in reversed(repositories)],
            ('objects', delete_objects),
            ('bucket', lambda: cf('owned R2 bucket delete', 'r2', 'buckets', 'delete', name, '--force', required=False) if state.get('bucket_creation_attempted') else None),
            ('namespace', lambda: cf('owned namespace delete', 'artifacts', 'namespaces', 'delete', name, '--force', required=False) if state.get('namespace_creation_attempted') else None),
        ]:
            try:
                operation()
                state['cleanup'][label] = 'attempted'
            except Exception:
                state['cleanup'][label] = 'failed'
        for label, argv in [('worker', ['workers', 'get', name]), ('bucket', ['r2', 'buckets', 'get', name]), ('namespace', ['artifacts', 'namespaces', 'get', name])]:
            p = command('absence readback ' + label, ['cf', '--profile', args.profile, *argv], required=False)
            state['cleanup'][label] = 'absent' if p.returncode != 0 and b'404 Not Found' in p.stderr else 'not_verified'
        for remote_url, token in automatic_tokens:
            try:
                p = git('automatic credential denied after repo deletion', 'ls-remote', remote_url, token=token, required=False)
                expiry = re.search(r'\?expires=(\d+)$', token)
                unexpired = expiry is None or int(expiry[1]) > time.time()
                state['cleanup']['automatic_credential_' + remote_url.rsplit('/', 1)[1]] = 'denied_after_deletion' if p.returncode and unexpired else 'not_verified'
                if expiry is None:
                    state.setdefault('limitations', []).append('Automatic Git credential expiry is opaque; observed usable before deletion and denied afterward, not independently timed expiry.')
            except Exception:
                state['cleanup']['automatic_credentials'] = 'failed'
        if r2_token_id:
            # cf OAuth can mint user tokens but its DELETE route returns403.
            # Use a five-minute, current-user token-management credential only
            # to delete our exact token ID, read it back, and then revoke itself.
            try:
                user = cf('cleanup current-user identity', 'user', 'get')
                policy = [{'effect': 'allow', 'resources': {'com.cloudflare.api.user.' + user['id']: '*'},
                           'permission_groups': [{'id': g['id']} for g in groups if g['name'] in ('API Tokens Read', 'API Tokens Write') and g.get('is_selectable')]}]
                if len(policy[0]['permission_groups']) != 2:
                    raise RuntimeError('credential cleanup permissions unavailable')
                expiry = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%SZ')
                cleanup = cf('five-minute token cleanup credential', 'user', 'tokens', 'create', '--name', name + '-cleanup', '--expires-on', expiry, '--policies', json.dumps(policy))
                state['cleanup_token_id'] = cleanup['id']
                save()
                cleanup_env = {**env, 'CLOUDFLARE_API_TOKEN': cleanup['value']}
                try:
                    command('owned R2 credential revoke', ['cf', 'user', 'tokens', 'delete', r2_token_id, '--force'], environment=cleanup_env)
                    p = command('absence readback R2 token', ['cf', 'user', 'tokens', 'get', r2_token_id], environment=cleanup_env, required=False)
                    state['cleanup']['r2_token'] = 'absent' if p.returncode and b'404 Not Found' in p.stderr else 'not_verified'
                finally:
                    command('cleanup credential self-revoke', ['cf', 'user', 'tokens', 'delete', cleanup['id'], '--force'], environment=cleanup_env)
                    p = command('self-revoked cleanup credential denied', ['cf', 'user', 'tokens', 'verify'], environment=cleanup_env, required=False)
                    state['cleanup']['cleanup_token'] = 'revoked' if p.returncode and b'401 Unauthorized' in p.stderr else 'not_verified'
            except Exception:
                state['cleanup']['credentials'] = 'failed'
        state['finished_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
        save()
    print(json.dumps({'state': state['state'], 'receipt': str(root / 'ownership.json'), 'cleanup': state['cleanup']}))
    return 0 if state['state'] == 'passed' and all(state['cleanup'].get(k) == 'absent' for k in ['worker', 'bucket', 'namespace', 'r2_token']) and state['cleanup'].get('cleanup_token') == 'revoked' and not any(v in ('failed', 'not_verified') for v in state['cleanup'].values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
