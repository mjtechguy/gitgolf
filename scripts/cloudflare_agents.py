"""CF2 live phase, called only from the foundation runner's owned scope."""
import hashlib
import json
import re
import secrets
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path

ROLES = ['agent-a', 'agent-b', 'cancel', 'timeout', 'integration']


def route_pending(status, value):
    # Only use for GET or the invalid {} admission: neither dispatches work.
    return (value.get('cloudflare_error') is True and (
        (status == 404 and value.get('error_code') == 1042) or
        (status == 500 and value.get('error_code') == 1104))) or (
        status == 503 and value.get('state') == 'unavailable' and
        re.fullmatch(r'internal error; reference = [a-z0-9]{16,64}', value.get('diagnostic', '')) is not None)


def qualify_agents(root, state, save, command, cf, git, mint, automatic_tokens, object_keys):
    repo = Path(__file__).resolve().parent.parent
    account, profile, namespace = state['account'], state['profile'], state['run']
    worker = namespace + '-agents'
    build = root / 'agents'
    build.mkdir(mode=0o700)
    evidence = state['checks']['agents'] = {'state': 'running', 'worker': worker, 'tasks': {}, 'cleanup': {}}
    # Enumerate maintained sources only; never scan dependency or credential files.
    files = [Path(__file__).resolve(), repo / 'cloudflare/agents/prepare.mjs', repo / 'cloudflare/agents/Dockerfile',
             repo / 'cloudflare/agents/package-lock.json', *sorted((repo / 'cloudflare/agents/src').glob('*.mjs'))]
    evidence['source_sha256'] = {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    save()
    p = command('fresh agent Worker target', ['cf', '--profile', profile, 'workers', 'get', worker], required=False)
    if p.returncode == 0 or b'404 Not Found' not in p.stderr:
        raise RuntimeError('agent Worker target not confirmed absent')
    if cf('fresh agent container target', 'containers', 'applications', 'list', '--name', worker, '--per-page', '10'):
        raise RuntimeError('agent container target exists')
    writer = mint('baseline', 'write')
    baseline = root / 'imported'
    (baseline / 'calc.py').write_text('def add(a, b):\n    return a - b\n\ndef multiply(a, b):\n    return a + b\n')
    (baseline / 'test_calc.py').write_text('import unittest\nfrom calc import add, multiply\nclass Math(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n    def test_multiply(self): self.assertEqual(multiply(2, 3), 6)\n')
    git('fixture add', '-C', baseline, 'add', 'calc.py', 'test_calc.py')
    git('fixture commit', '-C', baseline, 'commit', '-m', 'Golf CF2 controlled test fixture')
    base = git('fixture commit identity', '-C', baseline, 'rev-parse', 'HEAD').stdout.decode().strip()
    tree = git('fixture tree identity', '-C', baseline, 'rev-parse', 'HEAD^{tree}').stdout.decode().strip()
    baseline_remote = f'https://{account}.artifacts.cloudflare.net/git/{namespace}/baseline.git'
    git('controlled fixture publish', '-C', baseline, 'push', baseline_remote, 'HEAD:refs/heads/master', token=writer['plaintext'])
    evidence.update(base_commit=base, base_tree=tree)
    credentials, readers = {'GOLF_PROBE_TOKEN': secrets.token_urlsafe(32)}, {}
    for role in ROLES:
        state['repositories'].append(role)
        save()
        p = command('owned agent fork ' + role, ['node', 'cloudflare/qualification/prepare.mjs', str(root), shutil.which('cf'), 'fork', role])
        fork = json.loads(p.stdout)
        expected = f'https://{account}.artifacts.cloudflare.net/git/{namespace}/{role}.git'
        if fork['name'] != role or fork['remote'] != expected:
            raise RuntimeError('agent fork target differs from owned scope')
        automatic_tokens.append((expected, fork['token']))
        readers[role] = mint(role, 'read')['plaintext']
        credentials['GIT_' + role.replace('-', '_').upper() + '_READ'] = readers[role]
        credentials['GIT_' + role.replace('-', '_').upper() + '_WRITE'] = mint(role, 'write')['plaintext']
        object_keys.append(f'cf-agent/{namespace}/{role}/result.json')
    state['object_keys'] = object_keys.copy()
    save()
    metadata = json.loads(command('local native image identity', ['docker', 'image', 'inspect', 'golf-cf-agent:qualification', '--format', '{{json .}}']).stdout)
    image = metadata['Id']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise RuntimeError('agent image identity invalid')
    if metadata.get('Architecture') != 'amd64' or metadata.get('Os') != 'linux' or metadata.get('Descriptor', {}).get('mediaType') not in [
            'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']:
        raise RuntimeError('build a single linux/amd64 image with --provenance=false')
    evidence['image_id'] = image
    image_tag = worker + ':qualification'
    if cf('fresh agent image target', 'containers', 'images', 'list', '--filter', '^' + re.escape(worker) + '$'):
        raise RuntimeError('owned remote image target exists')
    command('tag exact owned agent image', ['docker', 'tag', image, image_tag])
    evidence['image_tag'] = image_tag
    settings = {'account': account, 'profile': profile, 'resources': {'worker': worker, 'bucket': namespace},
                'image': image_tag, 'secret_names': list(credentials), 'vars': {
                    'GOLF_ACCOUNT_ID': account, 'GOLF_NAMESPACE': namespace, 'GOLF_BASE_COMMIT': base,
                    'GOLF_BASE_TREE': tree, 'GOLF_GATEWAY': worker}}
    (build / 'ownership.json').write_text(json.dumps(settings, indent=2) + '\n')
    (build / 'ownership.json').chmod(0o600)
    app_created, deployed, url = False, False, None
    secret_file = build / 'probe-secret.json'

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def redacted(raw, limit, tail=False):
        value = raw.decode(errors='replace')
        for secret in credentials.values(): value = value.replace(secret, '[withheld]')
        value = re.sub(r'[A-Za-z0-9_-]{32,}', '[withheld]', value)
        return value[-limit:] if tail else value[:limit]

    def request(path, *, body=None, token=credentials['GOLF_PROBE_TOKEN'], method=None):
        headers = {'User-Agent': 'GolfCloudflareQualification/1.0', 'Accept': 'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + token
        data = None if body is None else json.dumps(body).encode()
        if data: headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url + path, data=data, headers=headers, method=method)
        try: response = client.open(req, timeout=30)
        except urllib.error.HTTPError as error: response = error
        with response:
            raw = response.read((1 << 20) + 1)
            if len(raw) > 1 << 20: raise RuntimeError('agent HTTP response exceeds bound')
            if response.status >= 500:
                evidence.setdefault('http_failures', []).append({'path': path, 'status': response.status,
                    'body': redacted(raw, 4096)})
                save()
            try: result = json.loads(raw)
            except json.JSONDecodeError:
                if response.status == 404: return 404, {'platform_route_pending': True}
                raise RuntimeError('agent HTTP response not JSON') from None
            if response.status == 404 and 'state' not in result: return 404, result
            if 'no-store' not in [v.strip() for v in (response.headers.get('Cache-Control') or '').split(',')]:
                raise RuntimeError('agent response cache boundary failed')
            return response.status, result

    def read_ready(path, token=credentials['GOLF_PROBE_TOKEN']):
        deadline = time.monotonic() + 30
        while True:
            status, value = request(path, token=token)
            if not route_pending(status, value): return status, value
            evidence['script_propagation_waits'] = evidence.get('script_propagation_waits', 0) + 1
            save()
            if time.monotonic() >= deadline: raise RuntimeError('fresh agent script did not become ready')
            time.sleep(.5)

    def wait(role, predicate, timeout=150):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            status, result = read_ready('/tasks/' + role)
            if status != 200: raise RuntimeError('task inspection failed')
            evidence['tasks'][role] = result
            save()
            if predicate(result): return result
            if result['state'] in ['failed', 'lost', 'cancelled', 'timed_out']:
                raise RuntimeError('native agent task failed; private receipt retained')
            time.sleep(1)
        raise RuntimeError('agent task deadline exceeded')

    def verify_receipt(role, result):
        expected = f'cf-agent/{namespace}/{role}/result.json'
        if result.get('evidence', {}).get('key') != expected: raise RuntimeError('agent evidence outside owned scope')
        raw = command('private immutable agent evidence ' + role, ['cf', '--profile', profile, 'r2', 'objects', 'get', expected, '--bucket-name', namespace]).stdout
        checksum = hashlib.sha256(raw).hexdigest()
        if checksum != result['evidence']['sha256']: raise RuntimeError('agent R2 evidence hash differs')
        retained = json.loads(raw)
        if retained['state'] != result['state'] or hashlib.sha256(retained['context']['prompt'].encode()).hexdigest() != result['prompt_sha256']:
            raise RuntimeError('agent retained context/outcome differs')
        evidence.setdefault('receipt_readbacks', {})[role] = {'key': expected, 'sha256': checksum, 'bytes': len(raw)}
        save()

    try:
        p = command('fresh agent gateway target', ['cf', '--profile', profile, 'ai-gateway', 'gateways', 'get', worker], required=False)
        if p.returncode == 0 or b'404 Not Found' not in p.stderr: raise RuntimeError('agent gateway target not confirmed absent')
        evidence['gateway_attempted'] = True
        save()
        cf('owned inference gateway create', 'ai-gateway', 'gateways', 'create', '--body', json.dumps({
            'id': worker, 'authentication': True, 'collect_logs': False, 'cache_ttl': 0, 'cache_invalidate_on_update': False,
            'rate_limiting_interval': 60, 'rate_limiting_limit': 30, 'rate_limiting_technique': 'fixed',
            'retry_max_attempts': 1, 'workers_ai_billing_mode': 'postpaid'}))
        evidence['gateway_created'] = True
        save()
        command('native agent build', ['node', 'cloudflare/agents/prepare.mjs', str(build), shutil.which('cf')])
        secret_file.write_text(json.dumps(credentials))
        secret_file.chmod(0o600)
        app_created = True
        evidence['deployment_attempted'] = True
        save()
        try:
            output = command('native agent deployment', ['cf', '--profile', profile, 'deploy', '--prebuilt', '--provision', 'false', '--secrets-file', str(secret_file)], cwd=build, timeout=240, required=False)
            if output.returncode:
                evidence['deployment_error'] = redacted(output.stderr, 8192)
                evidence['deployment_progress'] = redacted(output.stdout, 8192, tail=True)
                save()
                raise RuntimeError('native agent deployment failed; redacted diagnostic retained')
        finally: secret_file.unlink(missing_ok=True)
        urls = re.findall(rb'https://[^\s]+\.workers\.dev', output.stdout)
        if len(urls) != 1: raise RuntimeError('agent deployment URL not uniquely identified')
        url = urls[0].decode()
        evidence['url'] = url
        deployed = True
        native = cf('native agent Worker identity', 'workers', 'get', worker)
        if native['name'] != worker or native['subdomain']['url'] != url or native['subdomain']['previews_enabled']:
            raise RuntimeError('agent Worker identity differs')
        evidence['worker_id'] = native['id']
        deadline = time.monotonic() + 30
        stable = 0
        while stable < 5:
            status, value = read_ready('/inspect')
            if status == 200 and value.get('schema_version') == 'golf.cloudflare.agent-runtime.v1': stable += 1
            else: raise RuntimeError('agent route unavailable')
            if time.monotonic() >= deadline: raise RuntimeError('agent route readiness deadline exceeded')
            time.sleep(.5)
        if read_ready('/tasks/agent-a', token=None)[0] != 401 or read_ready('/tasks/agent-a', token='x' * 43)[0] != 401:
            raise RuntimeError('private task access boundary failed')
        prompts = {
            'agent-a': 'Read calc.py. Fix add by changing its body to exactly return a + b. Leave multiply and all other files unchanged. Use the edit tool. Do not run commands, commit or push.',
            'agent-b': 'Read calc.py. Fix add by changing its body to exactly return sum((a, b)), and fix multiply to exactly return a * b. Change calc.py only. Use the edit tool. Do not run commands, commit or push.',
        }
        # GET readiness does not prove fresh workers.dev POST routing. This
        # exact invalid body is rejected before any admission or dispatch write.
        for role in ROLES:
            deadline = time.monotonic() + 30
            while True:
                status, value = request('/tasks/' + role, body={})
                if status == 503 and value.get('diagnostic') == 'invalid admission': break
                if not route_pending(status, value) or time.monotonic() >= deadline: raise RuntimeError('agent admission route unavailable')
                time.sleep(.5)
            if read_ready('/tasks/' + role)[1].get('state') != 'none': raise RuntimeError('invalid admission created a task')
        # Admit both before waiting: independent DOs, containers, forks and keys.
        for role in ['agent-a', 'agent-b']:
            status, outcome = request('/tasks/' + role, body={'prompt': prompts[role], 'timeout_ms': 120000})
            if status != 202:
                evidence['admission_failure'] = {'role': role, 'status': status, 'outcome': outcome}
                save()
                raise RuntimeError('agent dispatch failed')
        if request('/tasks/agent-a', body={'prompt': prompts['agent-a'], 'timeout_ms': 120000})[0] != 409:
            raise RuntimeError('duplicate task could dispatch')
        deadline = time.monotonic() + 150
        while True:
            sa, a = read_ready('/tasks/agent-a')
            sb, b = read_ready('/tasks/agent-b')
            evidence['tasks'].update({'agent-a': a, 'agent-b': b})
            save()
            if sa != 200 or sb != 200: raise RuntimeError('overlap inspection failed')
            if all(r['state'] == 'running' and r.get('calls', 0) > 0 for r in [a, b]): break
            if any(r['state'] in ['failed', 'lost', 'succeeded'] for r in [a, b]) or time.monotonic() >= deadline:
                raise RuntimeError('actual concurrent inference not observed')
            time.sleep(.5)
        evidence['overlap_observed'] = {'observed_at': time.time(), 'agent_a': a['started_at'], 'agent_b': b['started_at']}
        a = wait('agent-a', lambda r: r['state'] == 'succeeded')
        b = wait('agent-b', lambda r: r['state'] == 'succeeded')
        if max(a['started_at'], b['started_at']) >= min(a['finished_at'], b['finished_at']):
            raise RuntimeError('native execution intervals do not overlap')
        if a['tests']['target']['exit_code'] or a['tests']['full']['exit_code'] == 0 or b['tests']['full']['exit_code']:
            raise RuntimeError('native positive/negative tests not observed')
        for role, result in [('agent-a', a), ('agent-b', b)]:
            remote = f'https://{account}.artifacts.cloudflare.net/git/{namespace}/{role}.git'
            git('fresh agent proposal clone ' + role, 'clone', '--depth', '2', '--branch', 'master', remote, root / role, token=readers[role])
            for rev, field in [('HEAD', 'proposal_commit'), ('HEAD^{tree}', 'proposal_tree')]:
                if git('agent exact proposal ' + role, '-C', root / role, 'rev-parse', rev).stdout.decode().strip() != result[field]:
                    raise RuntimeError('agent remote commit/tree differs')
            verify_receipt(role, result)
        status, advice = request('/advice', body={})
        if status != 200 or advice['state'] != 'completed' or not advice['advisory_only']:
            raise RuntimeError('native Clef advice unavailable')
        if request('/advice', body={})[1] != advice: raise RuntimeError('Clef reservation replay differs')
        evidence['clef'] = advice
        for role, duration in [('cancel', 120000), ('timeout', 10000)]:
            prompt = 'Read calc.py and carefully explain the arithmetic bugs and possible fixes before editing. Use the read tool. Do not run commands, commit or push.'
            if role == 'timeout':
                prompt = 'Read calc.py using the read tool. Then explain 200 distinct numeric test cases, showing inputs, current results and correct results for both functions for every case. Do not edit files, run commands, commit or push.'
            if request('/tasks/' + role, body={'prompt': prompt, 'timeout_ms': duration})[0] != 202:
                raise RuntimeError('negative task dispatch failed')
            wait(role, lambda r: r['state'] == 'running' and r.get('calls', 0) > 0)
            if role == 'cancel':
                if request('/tasks/cancel/cancel', body={})[0] != 200: raise RuntimeError('task cancellation failed')
            outcome = wait(role, lambda r: r['state'] == ('cancelled' if role == 'cancel' else 'timed_out'))
            if outcome.get('cleanup') != 'destroyed' or outcome.get('proposal_commit'):
                raise RuntimeError('negative task published or retained execution')
            remote = f'https://{account}.artifacts.cloudflare.net/git/{namespace}/{role}.git'
            actual = git('negative task unchanged remote ' + role, 'ls-remote', remote, 'refs/heads/master', token=readers[role]).stdout.decode().split()[0]
            if actual != base: raise RuntimeError('cancelled/timed-out proposal was published')
            verify_receipt(role, outcome)
        candidate = root / 'candidate'
        git('fresh integration base', 'clone', '--depth', '2', '--branch', 'master', baseline_remote, candidate, token=writer['plaintext'])
        for role in ['agent-a', 'agent-b']:
            git('fetch preserved proposal ' + role, '-C', candidate, 'fetch', '--depth', '2', f'https://{account}.artifacts.cloudflare.net/git/{namespace}/{role}.git',
                'master:refs/remotes/' + role + '/master', token=readers[role])
        git('first proposal integration', '-C', candidate, 'merge', '--no-ff', '--no-edit', a['proposal_commit'])
        conflict = git('deliberate overlapping proposal conflict', '-C', candidate, 'merge', '--no-ff', '--no-edit', b['proposal_commit'], required=False)
        unmerged = git('actual conflict paths', '-C', candidate, 'diff', '--name-only', '--diff-filter=U').stdout.decode().strip()
        if conflict.returncode == 0 or unmerged != 'calc.py': raise RuntimeError('real merge conflict not observed')
        git('resolve retained candidate', '-C', candidate, 'checkout', b['proposal_commit'], '--', 'calc.py')
        git('stage integration resolution', '-C', candidate, 'add', 'calc.py')
        git('commit new integration candidate', '-C', candidate, 'commit', '-m', 'Resolve both retained Golf proposals')
        merged = git('exact integration candidate', '-C', candidate, 'rev-parse', 'HEAD').stdout.decode().strip()
        merged_tree = git('exact integration tree', '-C', candidate, 'rev-parse', 'HEAD^{tree}').stdout.decode().strip()
        parents = git('retained candidate ancestry', '-C', candidate, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.decode().split()
        if len(parents) != 3 or parents[2] != b['proposal_commit'] or merged in [base, a['proposal_commit'], b['proposal_commit']]:
            raise RuntimeError('candidate did not preserve merge lineage')
        integration_remote = f'https://{account}.artifacts.cloudflare.net/git/{namespace}/integration.git'
        git('publish isolated integration candidate', '-C', candidate, 'push', integration_remote, 'HEAD:refs/heads/master', token=credentials['GIT_INTEGRATION_WRITE'])
        if request('/tasks/integration', body={'prompt': 'Test the exact combined candidate.', 'timeout_ms': 120000, 'commit': merged, 'tree': merged_tree})[0] != 202:
            raise RuntimeError('integration test admission failed')
        integrated = wait('integration', lambda r: r['state'] == 'succeeded')
        if integrated['proposal_commit'] != merged or integrated['proposal_tree'] != merged_tree or integrated['tests']['full']['exit_code']:
            raise RuntimeError('new candidate did not get its own successful tests')
        verify_receipt('integration', integrated)
        # Deliberately move the parent. This proof never promotes to its branch.
        (baseline / 'README').write_text('Parent moved after agent admission.\n')
        git('advance parent stage', '-C', baseline, 'add', 'README')
        git('advance parent commit', '-C', baseline, 'commit', '-m', 'Deliberately move parent after proposal admission')
        git('advance parent publish', '-C', baseline, 'push', baseline_remote, 'HEAD:refs/heads/master', token=writer['plaintext'])
        current = git('inspect current integration base', 'ls-remote', baseline_remote, 'refs/heads/master', token=writer['plaintext']).stdout.decode().split()[0]
        if current == base: raise RuntimeError('moved base not observed')
        evidence['comparison'] = {'base_commit': base, 'current_base': current, 'stale_base': True, 'promotion': 'withheld',
            'conflict_path': unmerged, 'proposals': [a['proposal_commit'], b['proposal_commit']], 'candidate': merged, 'candidate_tree': merged_tree,
            'candidate_parents': parents[1:], 'fresh_candidate_tests': integrated['tests']}
        for role, result in [('agent-a', a), ('agent-b', b)]:
            remote = f'https://{account}.artifacts.cloudflare.net/git/{namespace}/{role}.git'
            if git('proposal retained after conflict ' + role, 'ls-remote', remote, 'refs/heads/master', token=readers[role]).stdout.decode().split()[0] != result['proposal_commit']:
                raise RuntimeError('proposal lost during integration')
        evidence['state'] = 'passed'
    except Exception as error:
        evidence['state'] = 'failed'
        evidence['failure'] = str(error) if isinstance(error, RuntimeError) else 'qualification operation failed'
        save()
        raise
    finally:
        if deployed:
            for role in ROLES:
                try:
                    status, outcome = request('/tasks/' + role + '/cancel', body={})
                    if status != 200: raise RuntimeError('native cancellation failed')
                    evidence.setdefault('cleanup_outcomes', {})[role] = outcome
                except Exception: evidence['cleanup']['container_' + role] = 'failed'
        if app_created:
            try:
                command('retire owned native agent class', ['node', 'cloudflare/agents/prepare.mjs', str(build), shutil.which('cf'), 'retire'])
                command('native agent class retirement', ['cf', '--profile', profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=build, timeout=120)
            except Exception: evidence['cleanup']['retirement'] = 'failed'
            try:
                apps = cf('owned agent application inventory', 'containers', 'applications', 'list', '--name', worker, '--per-page', '10')
                if len(apps) >= 10 or any(app['name'] != worker for app in apps): raise RuntimeError('ambiguous owned application')
                evidence['applications'] = [{'id': app['id'], 'name': app['name']} for app in apps]
                for app in apps: cf('owned agent application delete', 'containers', 'applications', 'delete', app['id'], '--force')
                if cf('agent application absence', 'containers', 'applications', 'list', '--name', worker, '--per-page', '10'):
                    raise RuntimeError('agent application remains')
                evidence['cleanup']['applications'] = 'absent'
            except Exception: evidence['cleanup']['applications'] = 'failed'
            try:
                namespaces = cf('agent Durable Object namespace absence', 'durable-objects', 'namespaces', 'list', '--per-page', '100')
                if not isinstance(namespaces, list) or len(namespaces) >= 100 or any(
                        not isinstance(item.get('script'), str) or item['script'] == worker for item in namespaces):
                    raise RuntimeError('owned namespace remains or inventory is ambiguous')
                evidence['cleanup']['durable_object_namespace'] = 'absent'
            except Exception: evidence['cleanup']['durable_object_namespace'] = 'failed'
            cf('owned agent Worker delete', 'workers', 'delete', worker, '--force', required=False)
            p = command('agent Worker absence', ['cf', '--profile', profile, 'workers', 'get', worker], required=False)
            evidence['cleanup']['worker'] = 'absent' if p.returncode and b'404 Not Found' in p.stderr else 'failed'
            try:
                cf('owned agent image delete', 'containers', 'images', 'delete', image_tag, '--force', required=False)
                remaining = cf('owned agent image absence', 'containers', 'images', 'list', '--filter', '^' + re.escape(worker) + '$')
                if remaining: raise RuntimeError('owned agent image remains')
                evidence['cleanup']['image'] = 'absent'
            except Exception: evidence['cleanup']['image'] = 'failed'
        if evidence.get('gateway_attempted'):
            cf('owned inference gateway delete', 'ai-gateway', 'gateways', 'delete', worker, '--force', required=False)
            p = command('agent gateway absence', ['cf', '--profile', profile, 'ai-gateway', 'gateways', 'get', worker], required=False)
            evidence['cleanup']['gateway'] = 'absent' if p.returncode and b'404 Not Found' in p.stderr else 'failed'
        save()
        command('owned local image tag cleanup', ['docker', 'image', 'rm', image_tag], required=False)
    if evidence['state'] != 'passed' or any(v == 'failed' for v in evidence['cleanup'].values()):
        raise RuntimeError('agent qualification or cleanup failed')


if __name__ == '__main__':
    assert route_pending(503, {'state': 'unavailable', 'diagnostic': 'internal error; reference = d321bvamfudqrk136miv4e49'})
    assert route_pending(500, {'cloudflare_error': True, 'error_code': 1104})
    assert not route_pending(500, {'cloudflare_error': True, 'error_code': 1101})
    assert not route_pending(503, {'state': 'unavailable', 'diagnostic': 'invalid admission'})
    assert not route_pending(503, {'state': 'lost', 'diagnostic': 'internal error; reference = d321bvamfudqrk136miv4e49'})
    print('Read-only readiness boundary passed')
