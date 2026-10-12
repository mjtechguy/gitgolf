"""Recover cleanup of an owned disposable demo whose original supervisor exited."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request

from cloudflare_demo import load_receipt, process_matches
from cloudflare_release import ASSET
from cloudflare_setup import replace_private_json

ROOT = Path(__file__).resolve().parents[1]


def missing_response(stderr):
    return re.search(r'\b404\s+(?:│\s*)?Not\s+Found\b', stderr.decode(errors='replace')) is not None


def same(current, original, fields):
    if any(current.get(field) != original.get(field) for field in fields):
        raise ValueError('Owned resource identity changed; cleanup refused')


def index_inventory(rows):
    if len(rows) > 256 or any(not re.fullmatch(r'repository-indexes/v1/[a-f0-9]{64}/[a-f0-9]{40}/[a-f0-9]{64}\.json', row['key']) or not re.fullmatch('[a-f0-9]{64}', row['payload_hash']) or type(row['payload_bytes']) is not int or not 0 <= row['payload_bytes'] <= 256 * 1024 for row in rows):
        raise ValueError('Repository index ownership differs')
    return {row['key']: {'sha256': row['payload_hash'], 'bytes': row['payload_bytes']} for row in rows}


def retire_owned(label, inspect, delete, original, fields, journal, save):
    current = inspect()
    if current is None:
        journal[label] = 'absent'; save(); return
    if journal.get(label) == 'absent':
        raise ValueError('A confirmed retired resource reappeared; cleanup refused')
    same(current, original, fields)
    journal[label] = 'deleting'; save()
    delete()
    if inspect() is not None:
        raise RuntimeError('Owned resource deletion is still pending')
    journal[label] = 'absent'; save()


def require_purged_apps(previews):
    if len(previews) > 100 or any(row.get('kind') not in ('STATIC', 'WORKER') or row['kind'] == 'WORKER' and not row['purged'] for row in previews):
        raise ValueError('Demo app cleanup is still pending; keep the provider cleaner available')


def retire_demo_apps(state, settings, previews, cf, query, post):
    pending = [row for row in previews if row.get('kind') == 'WORKER' and not row.get('purged')]
    if not pending:
        return
    originals = {row['id']: row for row in state['demo']['previews']}
    if len(pending) > 4 or any(row['id'] not in originals or originals[row['id']]['kind'] != 'WORKER' for row in pending):
        raise ValueError('Pending application differs from the original demo')
    if settings['origin'] != state['demo']['url'].rstrip('/') or settings['workspace'] != 'alice':
        raise ValueError('Demo application cleanup origin or workspace differs')
    rows = query('SELECT p.id,p.repository_id,r.name,r.creator_id FROM previews p JOIN repositories r ON r.id=p.repository_id', [])
    selected = [next((row for row in rows if row['id'] == p['id']), None) for p in pending]
    if any(row is None or row['creator_id'] != 1 for row in selected):
        raise ValueError('Demo application cleanup owner differs')
    original = state['resources']['preview_service_token']
    current = cf('zero-trust', 'access', 'service-tokens', 'get', original['id'])
    same(current, original, ['id', 'name'])
    rotated = cf('zero-trust', 'access', 'service-tokens', 'rotate', original['id'])
    same(rotated, original, ['id', 'name'])
    credential = 'golf_native_' + secrets.token_urlsafe(32)
    digest = hashlib.sha256(credential.encode()).hexdigest()
    try:
        query('INSERT INTO credentials(digest,user_id,expires_at) VALUES(?,?,?)', [digest, 1, int(dt.datetime.now(dt.timezone.utc).timestamp()) + 300])
        headers = {'Origin': settings['origin'], 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + credential,
                   'CF-Access-Client-Id': rotated['client_id'], 'CF-Access-Client-Secret': rotated['client_secret']}
        for row in selected:
            value = post(settings['origin'] + '/native/pr-preview', {'action': 'revoke', 'previewId': row['id'],
                         'repository': {'owner': 'alice', 'name': row['name']}, 'repositoryId': str(row['repository_id'])}, headers)
            if value.get('preview', {}).get('id') != row['id'] or not value['preview'].get('purged'):
                raise RuntimeError('Owned application retirement is not confirmed')
    finally:
        query('UPDATE credentials SET revoked=1 WHERE digest=?', [digest])


def post_demo_cleanup(url, payload, headers):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
            data = response.read(262145)
            if response.status != 200 or len(data) > 262144:
                raise RuntimeError('Owned application cleanup response differs')
            return json.loads(data)
    except urllib.error.HTTPError as error:
        raise RuntimeError('Owned application cleanup HTTP status ' + str(error.code)) from None


def retire_workers(resources, retire, detach_control):
    def worker(key):
        original = resources[key]
        retire(key, ('workers', 'get', original['name']), ('workers', 'delete', original['id'], '--force'), original, ['id', 'name'])
    # Preview calls the control Worker; control binds the application outbound Worker.
    worker('preview_worker')
    detach_control()
    worker('worker')
    worker('app_outbound')


def recovery_tokens(previous, name):
    rows = list(previous.get('pending_recovery_tokens', []))
    current = previous.get('recovery_token')
    if current and current.get('state') != 'absent': rows.append(current)
    if len(rows) > 20 or any(not re.fullmatch('[a-f0-9]{32}', row.get('id', '')) or row.get('name') != name + '-recovery' for row in rows):
        raise ValueError('Recovery credential inventory differs')
    return list({row['id']: {'id': row['id'], 'name': row['name']} for row in rows}.values())


def retained_assets(directory, account, worker):
    journal = directory / 'release-journal.json'
    if not journal.exists():
        return {}
    value = json.loads(journal.read_text())
    if any(value.get(key) != expected for key, expected in [('account', account), ('worker', worker), ('bucket', worker)]) or len(value.get('assets', {})) > 768:
        raise ValueError('Retained asset ownership differs')
    for key, asset in value['assets'].items():
        if key != asset.get('key') or not ASSET.fullmatch(key) or not re.fullmatch('[a-f0-9]{64}', asset.get('sha256', '')) or not re.fullmatch('[a-f0-9]{32}', asset.get('etag', '')) or type(asset.get('bytes')) is not int or not 0 <= asset['bytes'] <= 4 * 1024 * 1024:
            raise ValueError('Invalid retained asset cleanup receipt')
    return value['assets']


def recover(receipt, check=False):
    receipt, state = load_receipt(receipt)
    if process_matches(state.get('demo_process', {})):
        raise ValueError('Stop the original running supervisor instead')
    name, account, profile = state['name'], state['account'], state['profile']
    if not re.fullmatch(r'golf-native-[0-9]{8}-[a-f0-9]{8}', name) or not re.fullmatch('[a-f0-9]{32}', account) or not re.fullmatch('[a-zA-Z0-9_-]{1,63}', profile) or receipt.parent.name != name:
        raise ValueError('Invalid owned demo identity')
    settings = json.loads((receipt.parent / 'forge.json').read_text())
    if settings['worker'] != name or settings['namespace'] != name or settings['account'] != account or settings['database']['uuid'] != state['resources']['database']['uuid']:
        raise ValueError('Prepared configuration differs from the ownership receipt')
    if any(os.environ.get(key) for key in ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY']):
        raise ValueError('Remove ambient Cloudflare credential overrides')
    environment = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': account, 'CF_SEND_TELEMETRY': 'false', 'CI': 'true'}
    cli, node = shutil.which('cf'), shutil.which('node')
    if not cli or not node:
        raise ValueError('Cleanup requires cf and node on PATH; include their binary directory in the stop timer environment')
    journal = receipt.parent / 'cleanup-recovery.json'
    previous = json.loads(journal.read_text()) if journal.exists() else {}
    if previous.get('account', account) != account or previous.get('name', name) != name:
        raise ValueError('Cleanup journal belongs to another demo')
    result = {'account': account, 'name': name, 'checked_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'state': 'checking', 'cleanup': previous.get('cleanup', {}), 'pending_recovery_tokens': recovery_tokens(previous, name)}

    def save():
        replace_private_json(journal, result)

    def command(*argv, timeout=60, missing=False):
        process = subprocess.run(list(argv), cwd=receipt.parent, env=environment, capture_output=True, timeout=timeout)
        if missing and process.returncode and missing_response(process.stderr):
            return None
        if process.returncode:
            raise RuntimeError('Cleanup command failed: ' + ' '.join(argv[:4]))
        return json.loads(process.stdout) if process.stdout.strip().startswith((b'{', b'[')) else None

    def cf(*args, **kwargs):
        return command(cli, '--profile', profile, *args, **kwargs)

    def query(sql, params=None):
        return cf('d1', 'query', settings['database']['uuid'], '--body', json.dumps({'sql': sql, 'params': params or []}))[0]['results']

    def removed(label):
        result['cleanup'][label] = 'absent'; save()

    def retire_cf(label, read, delete, original, fields):
        return retire_owned(label, lambda: cf(*read, missing=True), lambda: cf(*delete, missing=True), original, fields, result['cleanup'], save)

    resources = state['resources']
    database = cf('d1', 'get', settings['database']['uuid'], missing=True)
    if database is not None:
        same(database, resources['database'], ['uuid', 'name'])
    for key in ['worker', 'preview_worker', 'app_outbound']:
        current = cf('workers', 'get', resources[key]['name'], missing=True)
        if current is not None:
            same(current, resources[key], ['id', 'name'])
    queue = cf('queues', 'get', resources['queue']['id'], missing=True)
    if queue is not None:
        same(queue, {'queue_id': resources['queue']['id'], 'queue_name': name}, ['queue_id', 'queue_name'])
    bucket = cf('r2', 'buckets', 'get', name, missing=True)
    if bucket is not None:
        same(bucket, resources['bucket'], ['name', 'creation_date'])
    namespace = cf('workers-for-platforms', 'dispatch-namespaces', 'get', name, missing=True)
    if namespace is not None:
        same(namespace, resources['dispatch'], ['namespace_id'])
    snapshot = previous.get('storage_snapshot')
    if database is None and not snapshot:
        raise ValueError('Original database is absent without a reviewed recovery inventory')
    jobs = query('SELECT id,repository_id,report_key FROM evidence_jobs') if database else snapshot['jobs']
    previews = query('SELECT id,kind,bundle_key,capture_key,purged FROM previews') if database else snapshot['previews']
    if len(jobs) > 100:
        raise ValueError('Demo job inventory exceeds the cleanup bound')
    if database and not check:
        retire_demo_apps(state, settings, previews, cf, query, post_demo_cleanup)
        previews = query('SELECT id,kind,bundle_key,capture_key,purged FROM previews')
    require_purged_apps(previews)
    if database and query("SELECT preview_id FROM app_resources WHERE state!='DELETED'"):
        raise ValueError('Managed app resource cleanup must finish first')
    expected = {row['report_key'] for row in jobs if row['report_key']} | {row[key] for row in previews for key in ['bundle_key', 'capture_key'] if row[key]}
    assets = retained_assets(receipt.parent, account, name)
    index_columns = query('PRAGMA table_info(repository_indexes)') if database else None
    indexes = query('SELECT key,payload_hash,payload_bytes FROM repository_indexes') if index_columns else snapshot['indexes'] if not database else []
    index_inventory(indexes)
    expected.update(row['key'] for row in indexes)
    keys = cf('r2', 'objects', 'list', '--bucket-name', name, '--per-page', '1000') if bucket else []
    if len(keys) >= 1000 or any(row['key'] not in expected and row['key'] not in assets for row in keys):
        raise ValueError('Unexpected evidence objects; cleanup refused')
    for row in keys:
        if row['key'] in assets and (row['etag'].strip('"') != assets[row['key']]['etag'] or row['size'] != assets[row['key']]['bytes']):
            raise ValueError('Retained asset identity changed; cleanup refused')
    for row in jobs:
        if row['report_key'] and not re.fullmatch(r'pr-evidence/alice/[0-9]+/[a-f0-9-]{36}/[a-f0-9]{64}\.json', row['report_key']):
            raise ValueError('Unexpected evidence key')
    artifact_namespace = cf('artifacts', 'namespaces', 'get', name, missing=True)
    inventory = cf('artifacts', 'namespaces', 'repos', 'list', '--namespace', name, '--limit', '100') if artifact_namespace is not None else []
    repositories = inventory.get('repos') if isinstance(inventory, dict) else inventory
    if not isinstance(repositories, list) or len(repositories) >= 100 or any(not re.fullmatch('repo-[a-f0-9]{32}', row['name']) for row in repositories):
        raise ValueError('Unexpected Artifacts namespace inventory')
    result['storage_snapshot'] = {'jobs': jobs, 'previews': previews, 'indexes': indexes}
    save()
    if check:
        result.update(state='checked', jobs=len(jobs), previews=len(previews)); save(); return result

    groups = cf('user', 'tokens', 'permission-groups', 'list'); operator = cf('user', 'get')
    policies = []
    for names, scope in [(['Workers Scripts Write', 'Secrets Store Write'], 'com.cloudflare.api.account.' + account), (['API Tokens Read', 'API Tokens Write'], 'com.cloudflare.api.user.' + operator['id'])]:
        selected = [g for g in groups if g['name'] in names and g.get('is_selectable')]
        if len(selected) != len(names):
            raise ValueError('Cleanup token permissions unavailable')
        policies.append({'effect': 'allow', 'resources': {scope: '*'}, 'permission_groups': [{'id': g['id']} for g in selected]})
    expires = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=20)).strftime('%Y-%m-%dT%H:%M:%SZ')
    token = cf('user', 'tokens', 'create', '--name', name + '-recovery', '--expires-on', expires, '--policies', json.dumps(policies))

    def api(path, method='GET', missing=False):
        request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, method=method, headers={'Authorization': 'Bearer ' + token['value']})
        try:
            response = urllib.request.urlopen(request, timeout=20)
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise RuntimeError('Owned provider cleanup request failed') from None
        with response:
            data = response.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                raise ValueError('Provider response exceeds cleanup bound')
            value = json.loads(data) if data else {'success': True}
            if not value['success']:
                raise ValueError('Provider cleanup unconfirmed')
            return value.get('result')

    prefix = '/accounts/' + account
    try:
        result['recovery_token'] = {'id': token['id'], 'name': name + '-recovery', 'expires_on': expires, 'state': 'created'}; save()
        for old in list(result['pending_recovery_tokens']):
            path = '/user/tokens/' + old['id']
            retire_owned('recovery.' + old['id'], lambda: api(path, missing=True), lambda: api(path, 'DELETE', missing=True), old, ['id', 'name'], result['cleanup'], save)
            result['pending_recovery_tokens'].remove(old); save()
        for key in ['control_domain', 'preview_domain']:
            original = resources[key]; path = prefix + '/workers/domains/' + original['id']
            retire_owned(key, lambda: api(path, missing=True), lambda: api(path, 'DELETE', missing=True), original, ['id', 'hostname', 'service', 'zone_id'], result['cleanup'], save)
        queue = cf('queues', 'get', resources['queue']['id'], missing=True)
        for consumer in (queue or {}).get('consumers', []):
            same(consumer, {'script': name, 'type': 'worker'}, ['script', 'type'])
            cf('queues', 'consumers', 'delete', consumer['consumer_id'], '--queue-id', resources['queue']['id'], '--force')
        workflow = cf('workflows', 'get', name, missing=True)
        if workflow is not None:
            same(workflow, {'script_name': name, 'class_name': 'EvidenceWorkflow'}, ['script_name', 'class_name'])
            for job in jobs:
                current = cf('workflows', 'instances', 'get', job['id'], '--workflow-name', name, missing=True)
                if current is None:
                    continue
                if current['status'] not in ['complete', 'errored', 'terminated']:
                    cf('workflows', 'instances', 'terminate', job['id'], '--workflow-name', name, '--status', 'terminate', '--force')
                cf('workflows', 'instances', 'delete', job['id'], '--workflow-name', name, '--force')
        retire_cf('workflow', ('workflows', 'get', name), ('workflows', 'delete', name, '--force'), {'script_name': name, 'class_name': 'EvidenceWorkflow'}, ['script_name', 'class_name'])
        registry = None
        if resources.get('registry_bucket'):
            from types import SimpleNamespace
            from cloudflare_registry_check import RegistryProof
            registry_settings = json.loads((receipt.parent/'registry/registry.json').read_text())
            if registry_settings['account'] != account or registry_settings['worker'] != name + '-registry' or registry_settings['bucket'] != name + '-registry' or registry_settings['golfWorker'] != name:
                raise ValueError('Registry cleanup ownership differs')
            def registry_command(label, argv, *, cwd=receipt.parent, required=True, timeout=60):
                response = subprocess.run(argv, cwd=cwd, env=environment, capture_output=True, timeout=timeout)
                if required and response.returncode: raise RuntimeError(label + ' failed during recovery')
                return response
            def registry_cf(label, *argv, required=True):
                response = registry_command(label, [cli, '--profile', profile, *argv], required=required)
                return json.loads(response.stdout) if not response.returncode and response.stdout.strip() else None
            registry = RegistryProof(receipt.parent, state,
                SimpleNamespace(account_id=account, profile=profile, registry_host=urllib.parse.urlparse(registry_settings['origin']).hostname,
                    app_zone=resources.get('registry_domain', resources['control_domain'])['zone_id']),
                registry_cf, registry_command, api, save, [])
            registry.retire(); removed('registry_retired')
        def detach_control():
            if cf('workers', 'get', name, missing=True) is not None:
                command(node, str(ROOT / 'cloudflare/forge/prepare.mjs'), str(receipt.parent), cli, 'retire')
                cf('deploy', '--prebuilt', '--provision', 'false', timeout=120)
        retire_workers(resources, retire_cf, detach_control)
        if registry:
            registry.remove(); removed('registry_resources')
        for target in [name, name + '-agents']:
            applications = cf('containers', 'applications', 'list', '--name', target, '--per-page', '10')
            if len(applications) >= 10 or any(row['name'] != target for row in applications):
                raise ValueError('Unexpected container application')
            for row in applications:
                cf('containers', 'applications', 'delete', row['id'], '--force')
        removed('test_applications')
        cf('containers', 'images', 'delete', resources['test_image']['tag'], '--force', missing=True); removed('test_image')
        if namespace is not None and api(prefix + '/workers/dispatch/namespaces/' + name + '/scripts'):
            raise ValueError('Owned dispatch namespace is not empty')
        retire_cf('dispatch', ('workers-for-platforms', 'dispatch-namespaces', 'get', name), ('workers-for-platforms', 'dispatch-namespaces', 'delete', name, '--force'), resources['dispatch'], ['namespace_id'])
        retire_cf('queue', ('queues','get',resources['queue']['id']), ('queues','delete',resources['queue']['id'],'--force'), {'queue_id':resources['queue']['id'],'queue_name':name}, ['queue_id','queue_name'])
        retire_cf('gateway', ('ai-gateway','gateways','get',name), ('ai-gateway','gateways','delete',name,'--force'), {'id':name}, ['id'])
        # Writers are retired and every immutable key was ownership-checked above.
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda row: cf('r2', 'objects', 'delete', row['key'], '--bucket-name', name, '--force'), keys))
        retire_cf('bucket', ('r2','buckets','get',name), ('r2','buckets','delete',name,'--force'), resources['bucket'], ['name','creation_date'])
        for key, route in [('preview_access', ['zero-trust','access','applications']), ('control_access', ['zero-trust','access','applications']), ('preview_service_token', ['zero-trust','access','service-tokens']), ('demo_idp', ['zero-trust','identity-providers'])]:
            retire_cf(key, (*route,'get',resources[key]['id']), (*route,'delete',resources[key]['id'],'--force'), resources[key], ['id','name'])
        for row in repositories:
            cf('artifacts', 'namespaces', 'repos', 'delete', row['name'], '--namespace', name, '--force')
        if artifact_namespace is not None:
            cf('artifacts', 'namespaces', 'delete', name, '--force')
        if cf('artifacts','namespaces','get',name,missing=True) is not None:
            raise RuntimeError('Artifact namespace retirement is pending')
        removed('namespace')
        retire_cf('database', ('d1','get',settings['database']['uuid']), ('d1','delete',settings['database']['uuid'],'--force'), resources['database'], ['uuid','name'])
        store = resources['secret_store']; path = prefix + '/secrets_store/stores/' + store['id']
        current_store = api(path, missing=True)
        if current_store is not None:
            same(current_store, store, ['id','name'])
        secrets = api(path + '/secrets') if current_store is not None else []
        if not {(s['id'],s['name']) for s in secrets} <= {(s['id'],s['name']) for s in resources['secrets']}:
            raise ValueError('Secrets Store inventory changed')
        for secret in secrets:
            api(path + '/secrets/' + secret['id'], 'DELETE')
        retire_owned('secret_store', lambda: api(path,missing=True), lambda: api(path,'DELETE',missing=True), store, ['id','name'], result['cleanup'], save)
        for category in ['management_token','analytics_token']:
            if category in resources:
                api('/user/tokens/' + resources[category]['id'], 'DELETE', missing=True)
                if api('/user/tokens/' + resources[category]['id'], missing=True) is not None:
                    raise RuntimeError('Owned token retirement is pending')
                removed(category)
        result['state'] = 'removed'
    except Exception:
        result['state'] = 'failed'; raise
    finally:
        api('/user/tokens/' + token['id'], 'DELETE', missing=True)
        if cf('user', 'tokens', 'get', token['id'], missing=True) is not None:
            result['state'] = 'failed'; save()
            raise RuntimeError('Recovery credential retirement is pending')
        result['recovery_token']['state'] = 'absent'; save()
    state['cleanup'].update(result['cleanup'])
    if (receipt.parent / 'failure.txt').exists(): state['qualification_outcome'] = 'failed'
    state['state']='stopped'; state['finished_at']=dt.datetime.now(dt.timezone.utc).isoformat()
    replace_private_json(receipt, state)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt'); parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    print(json.dumps(recover(args.receipt, args.check)))
