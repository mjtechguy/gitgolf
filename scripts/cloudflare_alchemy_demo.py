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
    if value['settings']['evidence'].get('allow_ai'):
        account_names.add('AI Gateway Write')
    if value.get('operationsAnalytics'):
        account_names.add('Account Analytics Read')
    if value['settings'].get('email'):
        # Registers the sending subdomain; the Worker itself sends through its binding and holds no token.
        account_names.add('Email Sending Write')
    if value['settings'].get('search'):
        # Creates the search index and its metadata index; the Worker only reads and writes vectors through its binding.
        account_names.add('Vectorize Write')
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


def renew_credentials(directory, value, days):
    # The stack updates its management, registry and analytics tokens in place; their values and secrets stay as they are.
    if not 1 <= days <= 30:
        raise ValueError('Renew for 1 to 30 days')
    value['expiresAt'] = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')
    replace_private_json(directory/'alchemy-input.json', value)
    print('Installation credentials prepared to expire at '+value['expiresAt']+'; deploy to apply.')


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
            raise ValueError('Schema changed; run the migrate action before deployment')
    else:
        tables = query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'", [])[0]['results']
        if tables: raise ValueError('Existing schema has no bootstrap receipt; inspect before recovery')
        query(schema, [])
        replace_private_json(schema_path, identity)
    query('INSERT INTO workspaces(slug,artifact_namespace) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM workspaces)', [settings['workspace'], value['name']])
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


def enable_observability(directory, value):
    operations = value['settings'].setdefault('operations', {})
    operations['observability'] = {'enabled': True, 'sampling': 0.01}
    replace_private_json(directory/'alchemy-input.json', value)
    print('Bounded performance collection prepared; deploy to apply it with 1% redacted request logging.')


def enable_operations(directory, value):
    # Probes use the existing Artifacts and R2 bindings; the analytics feed gets its own read-only token at deploy.
    value['settings'].setdefault('operations', {})['service_health'] = True
    value['operationsAnalytics'] = True
    replace_private_json(directory/'alchemy-input.json', value)
    print('Service probes and the Workers analytics feed prepared; run renew-deploy for the analytics permission, then deploy.')


def enable_analytics(directory, value):
    # Analytics Engine datasets are created by their first write; the name only has to be a valid identifier.
    value['settings']['analytics_dataset'] = re.sub('[^A-Za-z0-9_]', '_', value['name'])[:64]
    replace_private_json(directory/'alchemy-input.json', value)
    print('PR evidence metrics prepared; deploy to bind the Analytics Engine dataset. Metrics are sampled, not billing.')


def enable_ai(directory, value, agent_path):
    # One private gateway per installation; the shared build validates the approved agent file.
    if not re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', value['name']):
        raise ValueError('The installation name cannot name an AI gateway')
    value['settings']['evidence'].update(allow_ai=True, gateway=value['name'])
    if agent_path:
        value['settings']['agent_path'] = agent_path
    replace_private_json(directory/'alchemy-input.json', value)
    print('Workers AI through a private gateway prepared'+(' with agent proposals for '+agent_path if agent_path else '')
        +'; run renew-deploy for the gateway permission, then deploy. Inference is billed by Cloudflare.')


def enable_workflow(directory, value, path):
    from cloudflare_forge import ACTIONS_WORKFLOW_PATH
    # Pull-request runs move to this one workflow path; the approved module stays for agent proposals.
    tests = value['settings'].get('tests')
    existing = tests.get('workflow') if isinstance(tests, dict) else None
    if not isinstance(tests, dict) or not isinstance(tests.get('module'), str) or existing is not None and (not isinstance(existing, dict) or existing.get('format') != 'actions'):
        raise ValueError('Enable a workflow on an installation whose tests approve a Python module')
    if not isinstance(path, str) or not re.fullmatch(ACTIONS_WORKFLOW_PATH, path):
        raise ValueError('Use --workflow-path .github/workflows/NAME.yml or NAME.yaml')
    tests['workflow'] = {'format': 'actions', 'path': path}
    replace_private_json(directory/'alchemy-input.json', value)
    print('Pull-request runs prepared for '+path+'; deploy to apply. The policy hashes change, so jobs queued across the deploy are refused, '
        'and every repository needs this file at each pull-request head.')


def enable_dead_letter(directory, value):
    value['settings']['evidence']['dead_letter'] = value['name']+'-dead'
    replace_private_json(directory/'alchemy-input.json', value)
    print('Evidence failure retention prepared; deploy to create the dead-letter queue and its consumer.')


def enable_webhooks(directory, value, origins):
    for origin in origins:
        if not re.fullmatch(r'https://[a-z0-9-]+(\.[a-z0-9-]+)+', origin):
            raise ValueError('Approve exact public HTTPS origins such as https://hooks.example.com')
    if not origins:
        raise ValueError('Approve at least one receiver with --origin')
    # Saved subscriptions are encrypted with this key, so a repeated run keeps the first one.
    value.setdefault('webhookKey', base64.b64encode(secrets.token_bytes(32)).decode())
    value['settings']['webhooks'] = {'origins': sorted(set(origins)), 'dailyLimit': 500}
    replace_private_json(directory/'alchemy-input.json', value)
    print('Repository webhooks prepared; deploy to store the encryption key and bind the approved origins.')


def rename_workspace(directory, value, slug):
    # The workspace row is found by its namespace, so renaming it and redeploying never strands a request.
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,38}', slug or ''):
        raise ValueError('Use a lowercase workspace name of up to 39 letters, digits or hyphens')
    settings = json.loads(private_read(directory/'forge.json'))
    database = cf(value, 'd1', 'get', settings['database']['uuid'])
    if database['name'] != value['name']: raise ValueError('Database ownership differs')
    def query(sql, params):
        return cf(value, 'd1', 'query', database['uuid'], '--body', json.dumps({'sql': sql, 'params': params}))[0]['results']
    rows = query('SELECT slug FROM workspaces WHERE artifact_namespace=?', [value['name']])
    if len(rows) != 1: raise ValueError('The installation workspace row is missing')
    if rows[0]['slug'] != slug:
        query('UPDATE workspaces SET slug=? WHERE artifact_namespace=?', [slug, value['name']])
        if query('SELECT slug FROM workspaces WHERE artifact_namespace=?', [value['name']])[0]['slug'] != slug: raise ValueError('Workspace rename readback differs')
    value['settings']['workspace'] = slug
    replace_private_json(directory/'alchemy-input.json', value)
    print('Workspace renamed to '+slug+'; deploy to apply. The old workspace object stops its maintenance alarm by itself.')


def enable_rate_limit(directory, value, limit, period):
    # The binding has no provider resource. Its namespace is a stable integer derived from the installation name.
    if type(limit) is not int or not 10 <= limit <= 10000 or type(period) is not int or period not in (10, 60):
        raise ValueError('Limit anonymous reads to 10-10000 requests per 10 or 60 seconds')
    namespace = str(int(hashlib.sha256(value['name'].encode()).hexdigest()[:8], 16) % 2147483647 + 1)
    value['settings']['anonymous_rate_limit'] = {'namespace': namespace, 'limit': limit, 'period': period}
    replace_private_json(directory/'alchemy-input.json', value)
    print('Anonymous read throttling prepared: about '+str(limit)+' public read or clone requests per '+str(period)+' seconds for each client network; deploy to bind it. '
        'Counts are approximate and kept per Cloudflare location. It applies only to public repositories and never to signed-in or credentialed requests.')


def enable_secrets(directory, value):
    # Stored repository values are encrypted with this key, so a repeated run keeps the first one. It is never the webhook key.
    value.setdefault('executionValueKey', base64.b64encode(secrets.token_bytes(32)).decode())
    if value['executionValueKey'] == value.get('webhookKey'):
        raise ValueError('Repository values need their own encryption key')
    replace_private_json(directory/'alchemy-input.json', value)
    workflow = (value['settings'].get('tests') or {}).get('workflow') or {}
    print('Repository value encryption key prepared; deploy to store and bind it.' + ('' if workflow.get('format') == 'actions' else
        ' Secrets and variables stay unavailable until this installation has an approved Actions workflow profile.'))


def enable_email(directory, value, limit):
    if type(limit) is not int or not 1 <= limit <= 5000:
        raise ValueError('Use a daily email attempt limit between 1 and 5000')
    if not re.fullmatch(r'[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+', value['hostname']) or len(value['hostname']) > 200:
        raise ValueError('The installation hostname cannot name a sending subdomain')
    # The outbox arrives with the current schema; the migrate action applies whatever the installation is missing.
    current = hashlib.sha256((ROOT/'cloudflare/forge/schema.sql').read_text().encode()).hexdigest()
    if json.loads(private_read(directory/'schema-receipt.json'))['sha256'] != current:
        raise ValueError('Run the migrate action before enabling email')
    # One sender on a sending subdomain of the installation's own hostname. No credential, and no recipient: mail goes to each account's own sign-in address.
    sender = 'golf@mail.'+value['hostname']
    value['settings']['email'] = {'sender': sender, 'dailyLimit': limit}
    replace_private_json(directory/'alchemy-input.json', value)
    print('Repository email prepared from '+sender+', at most '+str(limit)+' attempts a day; run renew-deploy for the Email Sending permission, then deploy.'
        +' Deployment registers the sending subdomain. The capability stays degraded until Cloudflare accepts a first message.')


def enable_search(directory, value, dimensions):
    # Embeddings go through the installation's private AI Gateway, so search needs enable-ai first.
    if not value['settings'].get('evidence', {}).get('allow_ai'):
        raise ValueError('Run enable-ai before enabling semantic search')
    if type(dimensions) is not int or not 32 <= dimensions <= 4096:
        raise ValueError('Use a Vectorize dimension between 32 and 4096')
    if len(value['name']+'-search') > 63:
        raise ValueError('The installation name cannot name a Vectorize index')
    # The search tables arrive with the current schema; the migrate action applies whatever the installation is missing.
    current = hashlib.sha256((ROOT/'cloudflare/forge/schema.sql').read_text().encode()).hexdigest()
    if json.loads(private_read(directory/'schema-receipt.json'))['sha256'] != current:
        raise ValueError('Run the migrate action before enabling semantic search')
    previous = value['settings'].get('search')
    value['settings']['search'] = {'index': value['name']+'-search', 'dimensions': dimensions}
    replace_private_json(directory/'alchemy-input.json', value)
    changed = previous is not None and previous.get('dimensions') != dimensions
    print('Semantic search prepared with a '+str(dimensions)+'-dimension Vectorize index (the embedding model comes from AI model selection and must produce this dimension); run renew-deploy for the Vectorize permission, then deploy.'
        +(' The dimension changed: deploy replaces the index and every repository index is rebuilt.' if changed else '')
        +' Repository administrators start indexing per repository; embedding calls are billed by Cloudflare.')


def enable_public(directory, value):
    if not re.fullmatch(r'https://[a-z0-9-]+\.cloudflareaccess\.com', value['settings'].get('access_team_domain', '')):
        raise ValueError('Public sites require the configured Access issuer for signed login cookies')
    settings = json.loads(private_read(directory/'forge.json'))
    database = cf(value, 'd1', 'get', settings['database']['uuid'])
    if database['name'] != value['name']: raise ValueError('Database ownership differs')
    # Public access needs the current schema; the migrate action applies whatever the installation is missing.
    current = hashlib.sha256((ROOT/'cloudflare/forge/schema.sql').read_text().encode()).hexdigest()
    receipt = json.loads(private_read(directory/'schema-receipt.json'))
    if receipt['database'] != database['uuid'] or receipt['sha256'] != current:
        raise ValueError('Run the migrate action before enabling public access')
    for table, expected in [('repository_visibility', {'repository_id','is_public','version'}),
                            ('public_profiles', {'owner_id','enabled','display_name','bio','location','website','readme','pinned','version'})]:
        rows = cf(value, 'd1', 'query', database['uuid'], '--body', json.dumps({'sql': 'PRAGMA table_info('+table+')', 'params': []}))[0]['results']
        if {row['name'] for row in rows} != expected: raise ValueError('Public schema readback differs')
    value['settings']['public_repositories'] = True
    replace_private_json(directory/'alchemy-input.json', value)
    print('Public access prepared; deploy to update the login path. Repositories remain private until explicitly published.')


def migration_objects(migration):
    """Name what a migration creates, refusing any statement that is unsafe to repeat."""
    names, trigger = [], False
    for statement in re.sub(r'--[^\n]*', '', migration).split(';'):
        statement = statement.strip()
        if trigger:
            trigger = statement.upper() != 'END'
            continue
        if not statement: continue
        match = re.match(r'CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\b', statement, re.I)
        if not match: raise ValueError('Only repeatable CREATE ... IF NOT EXISTS migrations are applied here')
        names.append(match.group(2))
        trigger = match.group(1).upper() == 'TRIGGER'
    if trigger or not names: raise ValueError('Migration is incomplete')
    return names


def pending_migrations(schema, applied, migrations):
    """Peel reviewed migrations off the schema's tail until it matches the applied schema."""
    pending = []
    for name, migration in sorted(migrations, reverse=True):
        if hashlib.sha256(schema.encode()).hexdigest() == applied: break
        if not schema.endswith('\n'+migration): raise ValueError('The schema does not end with '+name+'; inspect before migrating')
        pending.insert(0, (name, migration, schema))
        schema = schema[:-len('\n'+migration)]
    if hashlib.sha256(schema.encode()).hexdigest() != applied:
        raise ValueError('The applied schema is not a reviewed predecessor of this checkout')
    return pending


def migrate(directory, value):
    settings = json.loads(private_read(directory/'forge.json'))
    database = cf(value, 'd1', 'get', settings['database']['uuid'])
    receipt = json.loads(private_read(directory/'schema-receipt.json'))
    if database['name'] != value['name'] or receipt['database'] != database['uuid']: raise ValueError('Database ownership differs')
    migrations = [(path.name, path.read_text()) for path in (ROOT/'cloudflare/forge/migrations').glob('*.sql')]
    pending = pending_migrations((ROOT/'cloudflare/forge/schema.sql').read_text(), receipt['sha256'], migrations)
    objects = [migration_objects(migration) for _, migration, _ in pending]
    def query(sql, params=()):
        return cf(value, 'd1', 'query', database['uuid'], '--body', json.dumps({'sql': sql, 'params': list(params)}))[0]['results']
    # Each migration is additive and repeatable; the receipt advances only after its objects read back.
    for (name, migration, schema), names in zip(pending, objects):
        query(migration)
        found = {row['name'] for row in query('SELECT name FROM sqlite_master WHERE name IN ('+','.join('?'*len(names))+')', names)}
        if found != set(names): raise ValueError(name+' readback differs')
        replace_private_json(directory/'schema-receipt.json', {'database': database['uuid'], 'sha256': hashlib.sha256(schema.encode()).hexdigest()})
        print('Applied '+name)
    if not pending: print('Schema is current.')


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
        populated = seed_playgrounds(directory, ROOT, value['settings']['workspace'],
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
    parser.add_argument('action', choices=['prepare', 'plan', 'deploy', 'build', 'receipt', 'seed', 'destroy', 'renew-deploy', 'renew-credentials', 'enable-public', 'seed-public', 'enable-observability', 'enable-analytics', 'enable-webhooks', 'enable-ai', 'enable-workflow', 'enable-dead-letter', 'enable-operations', 'enable-rate-limit', 'migrate', 'enable-secrets', 'enable-email', 'enable-search', 'rename-workspace'])
    parser.add_argument('--slug', help='new workspace name for rename-workspace')
    parser.add_argument('--origin', action='append', default=[], help='approved webhook receiver origin for enable-webhooks')
    parser.add_argument('--days', type=int, default=7, help='lifetime for renew-credentials, 1 to 30 days')
    parser.add_argument('--email-limit', type=int, default=200, help='daily send attempts for enable-email, 1 to 5000')
    parser.add_argument('--limit', type=int, default=300, help='approximate anonymous requests per period for enable-rate-limit, 10 to 10000')
    parser.add_argument('--period', type=int, default=60, choices=[10, 60], help='counting period in seconds for enable-rate-limit')
    parser.add_argument('--dimensions', type=int, default=1024, help='Vectorize index dimension for enable-search; must match the embedding model')
    parser.add_argument('--agent-path', help='one approved source file; lets enable-ai also turn on agent proposals')
    parser.add_argument('--workflow-path', help='the one approved Actions workflow path for enable-workflow, .github/workflows/NAME.yml')
    parser.add_argument('directory', nargs='?')
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'prepare': return prepare(args.directory)
    directory, value = load(args.directory or os.environ['GOLF_ALCHEMY_DIRECTORY'])
    if args.action == 'renew-deploy': return renew_deploy(directory, value)
    if args.action == 'renew-credentials': return renew_credentials(directory, value, args.days)
    if args.action == 'seed-public':
        from cloudflare_public_demo import publish
        return publish(directory, ROOT)
    if args.action == 'enable-observability': return enable_observability(directory, value)
    if args.action == 'enable-analytics': return enable_analytics(directory, value)
    if args.action == 'enable-webhooks': return enable_webhooks(directory, value, args.origin)
    if args.action == 'enable-email': return enable_email(directory, value, args.email_limit)
    if args.action == 'enable-search': return enable_search(directory, value, args.dimensions)
    if args.action == 'enable-ai': return enable_ai(directory, value, args.agent_path)
    if args.action == 'enable-workflow': return enable_workflow(directory, value, args.workflow_path)
    if args.action == 'enable-dead-letter': return enable_dead_letter(directory, value)
    if args.action == 'enable-operations': return enable_operations(directory, value)
    if args.action == 'enable-rate-limit': return enable_rate_limit(directory, value, args.limit, args.period)
    if args.action == 'rename-workspace': return rename_workspace(directory, value, args.slug)
    if args.action == 'migrate': return migrate(directory, value)
    if args.action == 'enable-secrets': return enable_secrets(directory, value)
    if args.action == 'enable-public': return enable_public(directory, value)
    if args.action == 'build': return build(directory, value)
    if args.action == 'receipt': return receipt(directory, value)
    if args.action == 'seed': return seed(directory, value)
    if args.action == 'destroy': return destroy(directory, value)
    run(directory, value, args.action)


if __name__ == '__main__':
    main()
