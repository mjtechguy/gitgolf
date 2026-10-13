#!/usr/bin/env python3
"""Operate the parallel Alchemy demo; reuse Golf's build and content contract."""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

from cloudflare_setup import replace_private_json, private_read

ROOT = Path(__file__).resolve().parents[1]
STACK = ROOT/'deploy/alchemy/alchemy.run.ts'


def cf(config, *args):
    result = subprocess.run(['cf', '--profile', config['profile'], *map(str, args)],
        capture_output=True, timeout=120, env={**os.environ, 'CLOUDFLARE_ACCOUNT_ID': config['account'], 'CF_SEND_TELEMETRY': 'false'})
    if result.returncode:
        raise RuntimeError('cf operation failed: ' + ' '.join(map(str, args[:3])))
    return json.loads(result.stdout) if result.stdout.strip() else None


def load(directory):
    directory = Path(directory).resolve(strict=True)
    if not directory.is_relative_to(ROOT/'.tmp/cloudflare-forge') or directory.stat().st_mode & 0o077:
        raise ValueError('Use the private Alchemy installation directory')
    value = json.loads(private_read(directory/'alchemy-input.json'))
    if value['name'] != directory.name or not re.fullmatch('[a-f0-9]{32}', value['account']):
        raise ValueError('Alchemy installation identity differs')
    return directory, value


def prepare(receipt):
    from cloudflare_demo import load_receipt
    receipt, original = load_receipt(receipt)
    if original['state'] != 'retained':
        raise ValueError('Use the current retained demo as the configuration source')
    old = json.loads(private_read(receipt.parent/'forge.json'))
    name = 'golf-alchemy-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d') + '-' + secrets.token_hex(4)
    directory = ROOT/'.tmp/cloudflare-forge'/name
    directory.mkdir(mode=0o700)
    # Public configuration only: fresh resource IDs and authority are allocated below.
    settings = json.loads(json.dumps(old).replace(original['name'], name))
    image = 'golf-native-demo-python:repeatable'
    metadata = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{json .}}']))
    if metadata['Architecture'] != 'amd64' or metadata['Os'] != 'linux':
        raise ValueError('The demo image must be linux/amd64')
    settings['tests'].update(image=image, image_id=metadata['Id'])
    settings['web_assets'] = str(ROOT/'web/dist-native')
    settings['database'] = {'name': name, 'uuid': '00000000-0000-4000-8000-000000000000'}
    user = cf({'profile': original['profile'], 'account': old['account']}, 'd1', 'query', old['database']['uuid'],
        '--body', json.dumps({'sql': 'SELECT email FROM users WHERE id=1 AND active=1', 'params': []}))[0]['results']
    if len(user) != 1 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', user[0]['email']):
        raise ValueError('The retained administrator email is unavailable')
    value = {'name': name, 'account': old['account'], 'profile': original['profile'],
        'zone': old['apps']['policy']['zone'], 'hostname': old['hostname'],
        'previewHostname': old['previews']['origin'].removeprefix('https://'),
        'email': user[0]['email'],
        'expiresAt': (dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'signingKey': secrets.token_urlsafe(48), 'nativeToken': 'golf_native_'+secrets.token_urlsafe(32),
        'settings': settings, 'previousReceipt': str(receipt)}
    if original.get('deployment') == 'alchemy' or original.get('resources', {}).get('secret_store', {}).get('shared'):
        value['secretStoreId'] = old['registry']['apiToken']['store']
    replace_private_json(directory/'alchemy-input.json', value)
    (directory/'image').mkdir(mode=0o700)
    (directory/'image/Dockerfile').write_text('FROM '+image+'\n# Approved image: '+metadata['Id']+'\n')
    renew_deploy(directory, value)
    print(directory)


def renew_deploy(directory, value):
    path = directory/'operator.json'
    previous = json.loads(private_read(path)) if path.exists() else None
    groups = cf(value, 'user', 'tokens', 'permission-groups', 'list')
    account_names = {'Account Settings Read', 'Account API Tokens Write', 'Artifacts Write', 'D1 Write',
        'Workers Scripts Write', 'Workers R2 Storage Write', 'Workers Containers Write', 'Queues Write',
        'Secrets Store Write', 'Access: Apps and Policies Write',
        'Access: Organizations, Identity Providers, and Groups Write', 'Access: Service Tokens Write'}
    zone_names = {'Zone Read', 'DNS Write', 'Workers Routes Write'}
    policies = []
    for scope, names, resource in [('com.cloudflare.api.account', account_names, value['account']),
                                   ('com.cloudflare.api.account.zone', zone_names, value['zone'])]:
        selected = [g for g in groups if g['name'] in names and scope in g.get('scopes', []) and g.get('is_selectable')]
        if {g['name'] for g in selected} != names:
            raise ValueError('Alchemy deployment permissions are unavailable')
        policies.append({'effect': 'allow', 'resources': {scope+'.'+resource: '*'}, 'permission_groups': [{'id':g['id']} for g in selected]})
    token = cf(value, 'user', 'tokens', 'create', '--name', value['name']+'-deploy', '--expires-on',
        (dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=8)).strftime('%Y-%m-%dT%H:%M:%SZ'), '--policies', json.dumps(policies))
    replace_private_json(directory/'operator.json', token)
    if previous: cf(value, 'user', 'tokens', 'delete', previous['id'])


def build(directory, value):
    settings = json.loads(os.environ['GOLF_ALCHEMY_SETTINGS'])
    if settings['account'] != value['account'] or settings['worker'] != value['name']:
        raise ValueError('Build identity differs')
    replace_private_json(directory/'forge.json', settings)
    def query(sql, params):
        return cf(value, 'd1', 'query', settings['database']['uuid'], '--body', json.dumps({'sql': sql, 'params': params}))
    schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
    identity = {'database': settings['database']['uuid'], 'sha256': hashlib.sha256(schema.encode()).hexdigest()}
    schema_path = directory/'schema-receipt.json'
    if schema_path.exists():
        if json.loads(private_read(schema_path)) != identity:
            raise ValueError('Schema changed; use the guarded native migration procedure before deployment')
    else:
        tables = query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'", [])[0]['results']
        if tables: raise ValueError('Existing schema has no bootstrap receipt; inspect before recovery')
        query(schema, [])
        replace_private_json(schema_path, identity)
    query('INSERT INTO workspaces(slug,artifact_namespace) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM workspaces)', ['alice', value['name']])
    query("INSERT INTO users(id,login,email,can_create) VALUES(1,'mike',?,1) ON CONFLICT(id) DO NOTHING", [value['email']])
    query('INSERT INTO operations_admins(user_id) VALUES(1) ON CONFLICT(user_id) DO NOTHING', [])
    query('INSERT INTO credentials(digest,user_id,expires_at) VALUES(?,1,?) ON CONFLICT(digest) DO NOTHING',
        [hashlib.sha256(value['nativeToken'].encode()).hexdigest(), int(dt.datetime.now(dt.timezone.utc).timestamp())+18000])
    subprocess.run(['npm', '--prefix', 'web', 'run', 'build:native'], cwd=ROOT, check=True, timeout=120)
    subprocess.run(['node', 'cloudflare/forge/prepare.mjs', str(directory), shutil.which('cf')], cwd=ROOT, check=True, timeout=120)


def verify_image(value, reference):
    prefix = 'registry.cloudflare.com/'+value['account']+'/'+value['name']+'@'
    if not reference.startswith(prefix) or not re.fullmatch(r'sha256:[a-f0-9]{64}', reference[len(prefix):]):
        raise ValueError('Published image ownership differs')
    credentials = cf(value, 'containers', 'registries', 'credentials', 'generate',
        'registry.cloudflare.com', '--expiration-minutes', '5', '--permissions', 'pull')
    credentials = credentials.get('result', credentials)
    if credentials['account_id'] != value['account'] or credentials['registry_host'] != 'registry.cloudflare.com':
        raise ValueError('Registry credential scope differs')
    authorization = base64.b64encode((credentials['username']+':'+credentials['password']).encode()).decode()
    url = 'https://registry.cloudflare.com/v2/'+value['account']+'/'+value['name']+'/manifests/'+reference[len(prefix):]
    request = urllib.request.Request(url, headers={'Authorization': 'Basic '+authorization,
        'Accept': 'application/vnd.oci.image.manifest.v1+json'})
    with urllib.request.urlopen(request, timeout=30) as response: data = response.read()
    digest = 'sha256:'+hashlib.sha256(data).hexdigest()
    manifest = json.loads(data)
    if digest != reference[len(prefix):] or 'manifests' in manifest:
        raise ValueError('Runner must be the verified single-platform manifest, without a provenance index')
    if value['settings']['tests']['image_id'] not in [digest, manifest['config']['digest']]:
        raise ValueError('Published runner differs from the approved local image')
    return {'reference': reference, 'manifest': digest, 'config': manifest['config']['digest']}


def enable_public(directory, value):
    if not re.fullmatch(r'https://[a-z0-9-]+\.cloudflareaccess\.com', value['settings'].get('access_team_domain', '')):
        raise ValueError('Public sites require the configured Access issuer for signed login cookies')
    settings = json.loads(private_read(directory/'forge.json'))
    database = cf(value, 'd1', 'get', settings['database']['uuid'])
    if database['name'] != value['name']: raise ValueError('Database ownership differs')
    schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
    migration = (ROOT/'cloudflare/forge/migrations/0022_public_repositories.sql').read_text()
    if not schema.endswith('\n'+migration): raise ValueError('Inspect the schema migration before enabling public access')
    previous = hashlib.sha256(schema[:-len('\n'+migration)].encode()).hexdigest()
    current = hashlib.sha256(schema.encode()).hexdigest()
    receipt = json.loads(private_read(directory/'schema-receipt.json'))
    if receipt['database'] != database['uuid'] or receipt['sha256'] not in [previous, current]:
        raise ValueError('Public access migration requires the reviewed schema predecessor')
    cf(value, 'd1', 'query', database['uuid'], '--body', json.dumps({'sql': migration, 'params': []}))
    for table, expected in [('repository_visibility', {'repository_id','is_public','version'}),
                            ('public_profiles', {'owner_id','enabled','display_name','bio','location','website','readme','pinned','version'})]:
        rows = cf(value, 'd1', 'query', database['uuid'], '--body', json.dumps({'sql': 'PRAGMA table_info('+table+')', 'params': []}))[0]['results']
        if {row['name'] for row in rows} != expected: raise ValueError('Public schema readback differs')
    replace_private_json(directory/'schema-receipt.json', {'database':database['uuid'],'sha256':current})
    value['settings']['public_repositories'] = True
    replace_private_json(directory/'alchemy-input.json', value)
    print('Public access prepared; deploy to update the login path. Repositories remain private until explicitly published.')


def receipt(directory, value):
    result = json.loads(os.environ['GOLF_ALCHEMY_RECEIPT'])
    settings = result['settings']
    verified_image = verify_image(value, result['image'])
    auth_path = directory/'retained-auth.json'
    if not auth_path.exists():
        replace_private_json(auth_path, {'origin': settings['origin'], 'token': value['nativeToken'],
            'access_client_id': result['clientId'], 'access_client_secret': result['clientSecret']})
    path = directory/'ownership.json'
    previous = json.loads(private_read(path)) if path.exists() else {}
    state = {**previous, 'runner_image': verified_image, 'deployment': 'alchemy', 'state': previous.get('state', 'retained'),
        'account': value['account'], 'profile': value['profile'], 'name': value['name'],
        'resources': {**previous.get('resources', {}), 'namespace': value['name'], 'database': settings['database'],
            'worker': {'id': result['workerId'], 'name': value['name'], 'url': settings['origin']},
            'preview_worker': {'id': result['previewId'], 'name': value['name']+'-preview'},
            'preview_service_token': {'id': result['serviceTokenId'], 'name': value['name']+'-operator'}},
        'demo': {**previous.get('demo', {}), 'retained': True, 'url': settings['origin'],
            'credentials_expire_at': value['expiresAt'],
            'stop_command': 'python3 scripts/cloudflare_alchemy_demo.py destroy '+str(directory)}}
    replace_private_json(path, state)
    print('Alchemy installation receipt saved')


def seed(directory, value):
    from cloudflare_retained_demo import seed as seed_playgrounds
    auth = json.loads(private_read(directory/'retained-auth.json'))
    path = directory/'ownership.json'
    state = json.loads(private_read(path))
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    opener = urllib.request.build_opener(NoRedirect())
    headers = {'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'User-Agent': 'GolfNativeForgeQualification/1',
        'Authorization': 'Bearer '+auth['token'], 'CF-Access-Client-Id': auth['access_client_id'],
        'CF-Access-Client-Secret': auth['access_client_secret']}
    def http(route, body=None):
        request = urllib.request.Request(auth['origin']+route, data=json.dumps(body or {}).encode(), headers=headers)
        with opener.open(request, timeout=60) as response: return json.load(response)
    for attempt in range(90):
        try:
            session = http('/rpc/golf.v1.SessionService/GetSession')
            if session['user']['id'] != '1':
                raise ValueError('Demo administrator differs')
            break
        except (urllib.error.URLError, KeyError):
            if attempt == 89: raise
            time.sleep(2)
    if not state['demo'].get('repository_ids'):
        config = [('credential.helper', ''), ('core.hooksPath', os.devnull), ('http.followRedirects', 'false'),
            ('user.name', 'Mike Johnson'), ('user.email', value['email'])]
        config.extend(('http.extraHeader', key+': '+headers[key]) for key in ['Authorization', 'CF-Access-Client-Id', 'CF-Access-Client-Secret'])
        env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': str(len(config))}
        for i, (key, val) in enumerate(config):
            env['GIT_CONFIG_KEY_'+str(i)], env['GIT_CONFIG_VALUE_'+str(i)] = key, val
        def git(label, *args):
            result = subprocess.run(['git', *map(str, args)], env=env, capture_output=True, timeout=120)
            if result.returncode: raise RuntimeError(label+' failed')
            return result
        def record(label, data):
            state.setdefault('checks', {})[label] = data
            replace_private_json(path, state)
            print(json.dumps({'check': label, 'repository': data.get('repository')}), flush=True)
        populated = seed_playgrounds(directory, ROOT, 'alice',
            lambda method, body: http('/rpc/golf.v1.RepositoryService/'+method, body), http, git, record)
        state['demo'].update(populated)
        replace_private_json(path, state)
    subprocess.run([sys.executable, 'scripts/cloudflare-demo-deploy.py', 'apply', str(path)], cwd=ROOT, check=True, timeout=3000, umask=0o022)


def run(directory, value, action):
    token = json.loads(private_read(directory/'operator.json'))
    env = {**os.environ, 'CI': '1', 'ALCHEMY_TELEMETRY_DISABLED': '1', 'BUILDX_NO_DEFAULT_ATTESTATIONS': '1',
        'CLOUDFLARE_ACCOUNT_ID': value['account'], 'CLOUDFLARE_API_TOKEN': token['value'],
        'GOLF_ALCHEMY_DIRECTORY': str(directory)}
    command = ['node', str(ROOT/'deploy/alchemy/node_modules/alchemy/bin/cli.js'),
        'deploy' if action == 'plan' else action, str(STACK), '--stage', value['name'], '--yes', '--no-input']
    # Model the occupied demo hostnames during the read-only preflight. Actual
    # deploy never adopts them: the old owned installation must be gone first.
    if action == 'plan': command.extend(['--dry-run', '--adopt'])
    os.umask(0o077)
    result = subprocess.run(command, cwd=directory, env=env)
    if result.returncode: raise RuntimeError('Alchemy '+action+' failed; original state is retained')


def destroy(directory, value):
    from cloudflare_demo_cleanup import managed_image_inventory
    state = json.loads(private_read(directory/'ownership.json'))
    if state.get('deployment') != 'alchemy' or state['name'] != value['name']:
        raise ValueError('Use an Alchemy-owned receipt')
    settings = json.loads(private_read(directory/'forge.json'))
    database = cf(value, 'd1', 'get', settings['database']['uuid'])
    if database['name'] != value['name']: raise ValueError('Database ownership differs')
    def query(sql, params=()):
        return cf(value, 'd1', 'query', database['uuid'], '--body', json.dumps({'sql':sql,'params':params}))[0]['results']
    if query("SELECT id FROM evidence_jobs WHERE state NOT IN ('SUCCEEDED','REFUSED','EXPIRED') LIMIT 1"):
        raise RuntimeError('Wait for active demo jobs before destruction')
    renew_deploy(directory, value)
    subprocess.run([sys.executable, 'scripts/cloudflare-demo-deploy.py', 'renew-authority', str(directory/'ownership.json')], cwd=ROOT, check=True)
    auth = json.loads(private_read(directory/'retained-auth.json'))
    from cloudflare_demo_cleanup import post_demo_cleanup
    headers = {'Origin':settings['origin'], 'Content-Type':'application/json', 'Authorization':'Bearer '+auth['token'],
        'CF-Access-Client-Id':auth['access_client_id'], 'CF-Access-Client-Secret':auth['access_client_secret']}
    previews = query('SELECT p.id,p.repository_id,r.name,COALESCE(o.slug,?) AS owner FROM previews p JOIN repositories r ON r.id=p.repository_id LEFT JOIN repository_owners ro ON ro.repository_id=r.id LEFT JOIN native_owners o ON o.id=ro.owner_id WHERE p.purged=0', [settings['workspace']])
    for preview in previews:
        retired = post_demo_cleanup(settings['origin']+'/native/pr-preview', {'action':'revoke', 'previewId':preview['id'],
            'repository':{'owner':preview['owner'],'name':preview['name']}, 'repositoryId':str(preview['repository_id'])}, headers)
        if retired['preview']['id'] != preview['id'] or not retired['preview']['purged']: raise RuntimeError('Preview cleanup pending')
    query('UPDATE users SET active=0')
    jobs = query('SELECT id,repository_id FROM evidence_jobs')
    images = managed_image_inventory(value['name'], jobs, cf(value, 'containers', 'images', 'list', '--filter', value['name']+'-r*'))
    inventory = cf(value, 'artifacts', 'namespaces', 'repos', 'list', '--namespace', value['name'], '--limit', '100')
    repositories = inventory.get('repos', []) if isinstance(inventory, dict) else inventory
    known = {row['artifact_name'] for row in query('SELECT artifact_name FROM repositories')}
    if len(repositories) >= 100 or {row['name'] for row in repositories} - known:
        raise ValueError('Unexpected Artifacts repository inventory')
    for image in images: cf(value, 'containers', 'images', 'delete', image, '--force')
    for repo in repositories: cf(value, 'artifacts', 'namespaces', 'repos', 'delete', repo['name'], '--namespace', value['name'], '--force')
    cf(value, 'artifacts', 'namespaces', 'delete', value['name'], '--force')
    run(directory, value, 'destroy')
    for image in cf(value, 'containers', 'images', 'list', '--filter', '^'+value['name']+'$'):
        if image['name'] != value['name'] or any(not re.fullmatch(r'(?:[a-f0-9]{16}|buildcache)', tag) for tag in image['tags']):
            raise ValueError('Container build cache ownership differs')
        for tag in image['tags']: cf(value, 'containers', 'images', 'delete', image['name']+':'+tag, '--force')
    operator = json.loads(private_read(directory/'operator.json'))
    cf(value, 'user', 'tokens', 'delete', operator['id'])
    state['state'] = 'stopped'
    replace_private_json(directory/'ownership.json', state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'plan', 'deploy', 'build', 'receipt', 'seed', 'destroy', 'renew-deploy', 'enable-public', 'seed-public'])
    parser.add_argument('directory', nargs='?')
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'prepare': return prepare(args.directory)
    directory, value = load(args.directory or os.environ['GOLF_ALCHEMY_DIRECTORY'])
    if args.action == 'renew-deploy': return renew_deploy(directory, value)
    if args.action == 'seed-public':
        from cloudflare_public_demo import publish
        return publish(directory, ROOT)
    if args.action == 'enable-public': return enable_public(directory, value)
    if args.action == 'build': return build(directory, value)
    if args.action == 'receipt': return receipt(directory, value)
    if args.action == 'seed': return seed(directory, value)
    if args.action == 'destroy': return destroy(directory, value)
    run(directory, value, args.action)


if __name__ == '__main__':
    main()
