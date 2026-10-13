"""Bounded release/rollback rehearsal inside an already owned disposable demo."""
import hashlib
import json
from pathlib import Path
import shutil
import time
from cloudflare_setup import replace_private_json

def require_converged_diagnostics(value, worker_release, worker_configuration=None):
    if not worker_release or value.get('release') != worker_release:
        raise RuntimeError('Worker and workspace release observations differ')
    if worker_configuration is not None and value.get('configuration') != worker_configuration:
        raise RuntimeError('Worker and workspace configuration observations differ')
    return value


def await_release(observe, expected, timeout=360, schema=18):
    deadline = time.monotonic() + timeout
    while True:
        try:
            value = observe('/native/diagnostics')
            if value.get('release') == expected and value.get('schema') == schema:
                return value
        except RuntimeError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('Served release/schema did not converge within its deadline')
        time.sleep(2)


def baseline_assets(source, destination):
    shutil.copytree(source, destination)
    native = Path(destination)/'native.html'
    if not native.is_file():
        raise ValueError('Build the native frontend before the release rehearsal')
    with native.open('a') as index:
        index.write('\n<!-- Disposable release rollback baseline -->\n')


def rehearse(directory, profile, observe, command, preview_context):
    directory = Path(directory)
    before = observe('/native/diagnostics')
    baseline = None
    if before['release'] == 'development':
        # Establish a real journaled predecessor; never label an unrecorded deployment compatible.
        settings_path = directory/'forge.json'
        settings = json.loads(settings_path.read_text())
        baseline_directory = directory/'rehearsal-assets'
        baseline_assets(settings['web_assets'], baseline_directory)
        try:
            replace_private_json(settings_path, {**settings, 'web_assets': str(baseline_directory)})
            command('prepare compatible rollback baseline', ['node', 'cloudflare/forge/release.mjs', str(directory), shutil.which('cf')])
            baseline = json.loads((directory/'release-manifest.json').read_text())
            for action in ['migrate', 'check', 'deploy']:
                command('baseline release ' + action, ['python3', 'scripts/cloudflare_release.py', action, str(directory), '--profile', profile], timeout=300)
            before = await_release(observe, baseline['release'], schema=baseline['schema'])
            denied = command('refuse unrecorded rollback predecessor', ['python3', 'scripts/cloudflare_release.py', 'rollback', str(directory), '--profile', profile], required=False, timeout=300)
            if not denied.returncode or b'private pending reviews' not in denied.stderr:
                raise RuntimeError('Schema18 rollback privacy guard was not enforced')
        finally:
            replace_private_json(settings_path, settings)
    command('prepare reviewed native release', ['node', 'cloudflare/forge/release.mjs', str(directory), shutil.which('cf')])
    manifest = json.loads((directory/'release-manifest.json').read_text())
    result = {'before': before, 'release': manifest['release'], 'schema': manifest['schema'], 'assets': [], 'unrecorded_rollback_denied': baseline is not None}
    # Each action acquires and releases the existing operator's installation lock.
    for action in ['migrate', 'check', 'deploy']:
        response = command('guarded release ' + action, ['python3', 'scripts/cloudflare_release.py', action, str(directory), '--profile', profile], timeout=300)
        result[action] = json.loads(response.stdout)['result']
    result['served'] = await_release(observe, manifest['release'], schema=manifest['schema'])
    for path, asset in manifest['assets'].items():
        data = observe(path, method='GET', raw=True)
        if len(data) != asset['bytes'] or hashlib.sha256(data).hexdigest() != asset['sha256']:
            raise RuntimeError('Served retained asset bytes differ from reviewed release')
        result['assets'].append({'path': path, 'bytes': len(data), 'sha256': asset['sha256']})
    # Access service tokens and ordinary Git credentials must not become human admin.
    denied = observe('/rpc/golf.v1.OperationsService/GetOperationsDashboard', expected=403)
    if denied.get('code') != 'permission_denied':
        raise RuntimeError('Operations service credential denial differed')
    result['machine_admin_denied'] = True
    for action, expected in [('rollback', before['release']), ('promote', manifest['release'])]:
        response = command('guarded release ' + action, ['python3', 'scripts/cloudflare_release.py', action, str(directory), '--profile', profile], timeout=300)
        result[action] = json.loads(response.stdout)['result']
        result[action + '_served'] = await_release(observe, expected, schema=before['schema'] if action == 'rollback' else manifest['schema'])
    from cloudflare_demo import renew_previews
    ownership = json.loads((directory/'ownership.json').read_text())
    if not ownership.get('demo', {}).get('unattended'):
        result['preview_renewal'] = renew_previews(observe, preview_context)
    return result
