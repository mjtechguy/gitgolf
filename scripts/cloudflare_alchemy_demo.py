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

from cloudflare_demo_manifest import admin_identity, read_manifest
from cloudflare_setup import hostname, replace_private_json, private_read

ROOT = Path(__file__).resolve().parents[1]
STACK = ROOT/'deploy/alchemy/alchemy.run.ts'
IMAGE = 'golf-native-demo-python:repeatable'
TEAM_DOMAIN = r'https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com'


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


def administrator(value):
    """The administrator login and Git author saved in the private input; older inputs derive them from the email."""
    return admin_identity(value['email'], value.get('adminLogin'), value.get('gitAuthorName'), value.get('gitAuthorEmail'))


def new_name():
    return 'golf-alchemy-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d') + '-' + secrets.token_hex(4)


def approved_image(image=IMAGE):
    metadata = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{json .}}']))
    if metadata['Architecture'] != 'amd64' or metadata['Os'] != 'linux':
        raise ValueError('The demo image must be linux/amd64; run python3 scripts/cloudflare-demo-deploy.py build-image')
    return metadata['Id']


def credentials(value, who):
    """Fresh installation secrets and the seven-day provider token lifetime."""
    value.update(expiresAt=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ'),
        signingKey=secrets.token_urlsafe(48), nativeToken='golf_native_'+secrets.token_urlsafe(32),
        adminLogin=who['login'], gitAuthorName=who['gitAuthorName'], gitAuthorEmail=who['gitAuthorEmail'])
    return value


def install(value, image, image_id):
    directory = ROOT/'.tmp/cloudflare-forge'/value['name']
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir(mode=0o700)
    replace_private_json(directory/'alchemy-input.json', value)
    (directory/'image').mkdir(mode=0o700)
    (directory/'image/Dockerfile').write_text('FROM '+image+'\n# Approved image: '+image_id+'\n')
    renew_deploy(directory, value)
    print(directory)


def init_input(name, account, profile, zone, host, preview_host, email, team_domain, image_id, who,
               secret_store=None, image=IMAGE, daily_limit=40, identity_provider=None):
    """The private Alchemy input for a fresh installation, without a previous receipt. Pure: contacts nothing."""
    if not re.fullmatch('golf-alchemy-[0-9]{8}-[a-f0-9]{8}', name):
        raise ValueError('Installation name differs')
    if not re.fullmatch('[a-f0-9]{32}', account or '') or not re.fullmatch('[a-f0-9]{32}', zone or ''):
        raise ValueError('Use the 32-character hexadecimal account and zone IDs')
    if not re.fullmatch('[a-zA-Z0-9_-]{1,63}', profile or ''):
        raise ValueError('Use the named cf CLI profile')
    hostname(host or ''), hostname(preview_host or '')
    if host == preview_host:
        raise ValueError('Use separate control and preview hostnames')
    if secret_store is not None and not re.fullmatch('[a-f0-9]{32}', secret_store):
        raise ValueError('Use the 32-character hexadecimal Secrets Store ID')
    if not re.fullmatch(TEAM_DOMAIN, team_domain or ''):
        raise ValueError('Use the Access team origin, https://TEAM.cloudflareaccess.com')
    if not re.fullmatch('sha256:[a-f0-9]{64}', image_id or ''):
        raise ValueError('Approved local Docker image ID required')
    if type(daily_limit) is not int or not 1 <= daily_limit <= 50:
        raise ValueError('Use a daily CI admission limit between 1 and 50')
    admin_identity(email, who['login'], who['gitAuthorName'], who['gitAuthorEmail'])
    preview = name + '-preview'
    # The same shape the Python installer records for a retained demo; the stack fills in database,
    # Access audiences and Secrets Store references when it creates them.
    settings = {'account': account, 'worker': name, 'namespace': name, 'workspace': who['login'],
        'database': {'name': name, 'uuid': '00000000-0000-4000-8000-000000000000'},
        'origin': 'https://'+host, 'hostname': host, 'workers_dev': False, 'ui': True,
        'web_assets': str(ROOT/'web/dist-native'), 'access_team_domain': team_domain, 'automatic_ci': True,
        'evidence': {'bucket': name, 'queue': name, 'workflow': name, 'daily_limit': daily_limit, 'allow_ai': False},
        'tests': {'image': image, 'image_id': image_id, 'module': 'test_calc'},
        'previews': {'worker': preview, 'origin': 'https://'+preview_host, 'path': 'public', 'ttl': 14400,
            'automatic': True, 'browser': True, 'workers_dev': False},
        'registry': {'provider': 'cloudflare', 'ci': True},
        'apps': {'policy': {'namespace': name, 'entry': 'worker.mjs', 'migration': 'schema.sql', 'ttl': 14400, 'zone': zone,
            'gateway': preview, 'outbound': name+'-outbound'}, 'automatic': True}}
    value = {'name': name, 'account': account, 'profile': profile, 'zone': zone, 'hostname': host,
        'previewHostname': preview_host, 'email': email, 'settings': settings}
    if secret_store:
        value['secretStoreId'] = secret_store
    if identity_provider is not None:
        if not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', identity_provider):
            raise ValueError('Use the Access identity provider UUID')
        # Zero Trust allows one one-time PIN login method per account. Reuse it unmanaged, so destroying
        # this installation never removes a login method another installation depends on.
        value['accessIdentityProviderId'] = identity_provider
    return credentials(value, who)


def existing_one_time_pin(config):
    """Read-only: the account's one-time PIN identity provider, if one exists."""
    providers = cf(config, 'zero-trust', 'identity-providers', 'list') or []
    if isinstance(providers, dict): providers = providers.get('result') or []
    pins = [p['id'] for p in providers if isinstance(p, dict) and p.get('type') == 'onetimepin' and p.get('id')]
    return pins[0] if pins else None


def init(args):
    """Prepare a fresh installation on an account with no previous Golf receipt."""
    if any(os.environ.get(k) for k in ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY']):
        raise ValueError('Remove ambient Cloudflare credential overrides; init uses the named cf profile')
    missing = [flag for flag in ['account_id', 'profile', 'zone_id', 'hostname', 'preview_hostname', 'email'] if not getattr(args, flag)]
    if missing:
        raise ValueError('init needs ' + ', '.join('--'+flag.replace('_', '-') for flag in missing))
    who = admin_identity(args.email, args.admin_login, args.git_author_name, args.git_author_email)
    team = args.access_team_domain
    if not team:
        # Read-only: the Access organization's issuer, which signs the login cookie the Worker verifies.
        organization = cf({'profile': args.profile, 'account': args.account_id}, 'zero-trust', 'organization', 'get')
        team = 'https://' + organization['auth_domain'] if organization and organization.get('auth_domain') else ''
    identity_provider = args.access_identity_provider_id or existing_one_time_pin({'profile': args.profile, 'account': args.account_id})
    value = init_input(new_name(), args.account_id, args.profile, args.zone_id, args.hostname, args.preview_hostname,
        args.email, team, approved_image(), who, args.secrets_store_id, daily_limit=args.evidence_daily_limit,
        identity_provider=identity_provider)
    install(value, IMAGE, value['settings']['tests']['image_id'])


def prepare(receipt, admin_login=None, author_name=None, author_email=None):
    """Copy a retained installation's public configuration into a fresh Alchemy installation (handoff)."""
    from cloudflare_demo import load_receipt
    receipt, original = load_receipt(receipt)
    if original['state'] != 'retained':
        raise ValueError('Use the current retained demo as the configuration source')
    old = json.loads(private_read(receipt.parent/'forge.json'))
    name = new_name()
    # Public configuration only: fresh resource IDs and authority are allocated below.
    settings = json.loads(json.dumps(old).replace(original['name'], name))
    image_id = approved_image()
    settings['tests'].update(image=IMAGE, image_id=image_id)
    settings['web_assets'] = str(ROOT/'web/dist-native')
    settings['database'] = {'name': name, 'uuid': '00000000-0000-4000-8000-000000000000'}
    user = cf({'profile': original['profile'], 'account': old['account']}, 'd1', 'query', old['database']['uuid'],
        '--body', json.dumps({'sql': 'SELECT email,login FROM users WHERE id=1 AND active=1', 'params': []}))[0]['results']
    if len(user) != 1 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', user[0]['email']):
        raise ValueError('The retained administrator email is unavailable')
    # The administrator keeps their current login unless another is given.
    who = admin_identity(user[0]['email'], admin_login or user[0]['login'], author_name, author_email)
    value = {'name': name, 'account': old['account'], 'profile': original['profile'],
        'zone': old['apps']['policy']['zone'], 'hostname': old['hostname'],
        'previewHostname': old['previews']['origin'].removeprefix('https://'),
        'email': user[0]['email'], 'settings': settings, 'previousReceipt': str(receipt)}
    credentials(value, who)
    if original.get('deployment') == 'alchemy' or original.get('resources', {}).get('secret_store', {}).get('shared'):
        value['secretStoreId'] = old['registry']['apiToken']['store']
    install(value, IMAGE, image_id)


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
    query('INSERT INTO users(id,login,email,can_create) VALUES(1,?,?,1) ON CONFLICT(id) DO NOTHING', [administrator(value)['login'], value['email']])
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


def enable_pipelines(directory, value, actions_url=None):
    # Actions/CI pipelines need the evidence allocation: the Worker, queue and coordinator are one installation.
    if not value['settings'].get('evidence'):
        raise ValueError('Actions pipelines require the evidence allocation')
    pipelines = {}
    if actions_url:
        if not re.fullmatch(r'https://[a-z0-9.-]+(:[0-9]+)?', actions_url):
            raise ValueError('Use an HTTPS origin such as https://code.forgejo.org for marketplace actions')
        pipelines['default_actions_url'] = actions_url
    value['settings']['pipelines'] = pipelines
    replace_private_json(directory/'alchemy-input.json', value)
    print('Actions pipelines prepared; deploy to create the logs and artifacts bucket, the intake queue with its dead-letter queue and the run coordinator. Deploy twice if Alchemy reports the new Durable Object class is unresolved. Run migrate first, then register runners under Settings > Runners.')


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


def seed(directory, value, manifest=None):
    """Create the CI/preview playgrounds, then claim the administrator's owner and import the manifest (None: no content)."""
    from cloudflare_retained_demo import seed as seed_playgrounds
    if manifest: read_manifest(manifest)
    who = administrator(value)
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
            ('user.name', who['gitAuthorName']), ('user.email', who['gitAuthorEmail'])]
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
    content = ['--manifest', str(Path(manifest).resolve())] if manifest else ['--no-seed']
    subprocess.run([sys.executable, 'scripts/cloudflare-demo-deploy.py', 'apply', str(path), *content], cwd=ROOT, check=True, timeout=3000, umask=0o022)


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


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Fresh install: init --account-id ... (no directory), then plan/deploy/seed DIRECTORY. '
        'Existing installation handoff: prepare /PATH/TO/ownership.json. See deploy/alchemy/README.md.')
    parser.add_argument('action', choices=['init', 'prepare', 'plan', 'deploy', 'build', 'receipt', 'seed', 'destroy', 'renew-deploy', 'renew-credentials', 'enable-public', 'seed-public', 'enable-observability', 'enable-analytics', 'enable-webhooks', 'enable-ai', 'enable-workflow', 'enable-dead-letter', 'enable-operations', 'enable-rate-limit', 'migrate', 'enable-secrets', 'enable-email', 'enable-search', 'enable-pipelines', 'rename-workspace'])
    parser.add_argument('--slug', help='new workspace name for rename-workspace')
    parser.add_argument('--origin', action='append', default=[], help='approved webhook receiver origin for enable-webhooks')
    parser.add_argument('--days', type=int, default=7, help='lifetime for renew-credentials, 1 to 30 days')
    parser.add_argument('--email-limit', type=int, default=200, help='daily send attempts for enable-email, 1 to 5000')
    parser.add_argument('--limit', type=int, default=300, help='approximate anonymous requests per period for enable-rate-limit, 10 to 10000')
    parser.add_argument('--period', type=int, default=60, choices=[10, 60], help='counting period in seconds for enable-rate-limit')
    parser.add_argument('--dimensions', type=int, default=1024, help='Vectorize index dimension for enable-search; must match the embedding model')
    parser.add_argument('--actions-url', help='HTTPS origin that resolves unqualified marketplace actions for enable-pipelines, such as https://code.forgejo.org')
    parser.add_argument('--agent-path', help='one approved source file; lets enable-ai also turn on agent proposals')
    parser.add_argument('--workflow-path', help='the one approved Actions workflow path for enable-workflow, .github/workflows/NAME.yml')
    parser.add_argument('directory', nargs='?', help='the installation directory printed by init or prepare; for prepare, the old ownership.json')
    fresh = parser.add_argument_group('init (fresh installation; nothing is read from a previous installation)')
    fresh.add_argument('--account-id', help='Cloudflare account ID (32 hex)')
    fresh.add_argument('--profile', help='authenticated cf CLI profile name')
    fresh.add_argument('--zone-id', help='zone ID (32 hex) holding both hostnames')
    fresh.add_argument('--hostname', help='unused control hostname, such as golf.example.com')
    fresh.add_argument('--preview-hostname', help='unused preview hostname, such as golf-previews.example.com')
    fresh.add_argument('--email', help='existing Cloudflare Access email of the administrator')
    fresh.add_argument('--secrets-store-id', help='existing Secrets Store ID; required when the account already has a store (one per account), otherwise the stack creates one')
    fresh.add_argument('--access-identity-provider-id', help='Existing one-time PIN Access identity provider to reuse; default: the account\'s existing one, if any')
    fresh.add_argument('--access-team-domain', help='https://TEAM.cloudflareaccess.com; default read from the account\'s Access organization')
    fresh.add_argument('--evidence-daily-limit', type=int, default=40, help='CI admissions per day, 1 to 50')
    who = parser.add_argument_group('administrator identity (init and prepare; saved in the private input for later actions)')
    who.add_argument('--admin-login', help='Golf login of the administrator; init derives it from --email, prepare keeps the current login')
    who.add_argument('--git-author-name', help='author of the playground commits; default the admin login')
    who.add_argument('--git-author-email', help='author email of the playground commits; default the administrator email')
    content = parser.add_argument_group('content (seed needs --manifest or --no-seed; seed-public needs --manifest)')
    content.add_argument('--manifest', type=Path, help='seed: deploy/demo/example.json, deploy/demo/mj.json or your own; seed-public: deploy/demo/example-public.json or deploy/demo/mj-public.json')
    content.add_argument('--no-seed', action='store_true', help='seed: create only the CI/preview playgrounds and the administrator\'s personal owner')
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.action == 'init':
            if args.directory: parser.error('init takes no directory; it prints the new one')
            return init(args)
        if args.action == 'prepare': return prepare(args.directory, args.admin_login, args.git_author_name, args.git_author_email)
    except ValueError as error:
        parser.error(str(error))
    if args.action == 'seed' and bool(args.manifest) == args.no_seed:
        parser.error('seed needs exactly one of --manifest PATH or --no-seed')
    if args.action == 'seed-public' and (not args.manifest or args.no_seed):
        parser.error('seed-public needs --manifest PATH, such as deploy/demo/example-public.json')
    directory, value = load(args.directory or os.environ['GOLF_ALCHEMY_DIRECTORY'])
    if args.action == 'renew-deploy': return renew_deploy(directory, value)
    if args.action == 'renew-credentials': return renew_credentials(directory, value, args.days)
    if args.action == 'seed-public':
        from cloudflare_public_demo import publish
        return publish(directory, ROOT, args.manifest)
    if args.action == 'enable-observability': return enable_observability(directory, value)
    if args.action == 'enable-analytics': return enable_analytics(directory, value)
    if args.action == 'enable-webhooks': return enable_webhooks(directory, value, args.origin)
    if args.action == 'enable-email': return enable_email(directory, value, args.email_limit)
    if args.action == 'enable-search': return enable_search(directory, value, args.dimensions)
    if args.action == 'enable-ai': return enable_ai(directory, value, args.agent_path)
    if args.action == 'enable-workflow': return enable_workflow(directory, value, args.workflow_path)
    if args.action == 'enable-dead-letter': return enable_dead_letter(directory, value)
    if args.action == 'enable-pipelines': return enable_pipelines(directory, value, args.actions_url)
    if args.action == 'enable-operations': return enable_operations(directory, value)
    if args.action == 'enable-rate-limit': return enable_rate_limit(directory, value, args.limit, args.period)
    if args.action == 'rename-workspace': return rename_workspace(directory, value, args.slug)
    if args.action == 'migrate': return migrate(directory, value)
    if args.action == 'enable-secrets': return enable_secrets(directory, value)
    if args.action == 'enable-public': return enable_public(directory, value)
    if args.action == 'build': return build(directory, value)
    if args.action == 'receipt': return receipt(directory, value)
    if args.action == 'seed': return seed(directory, value, args.manifest)
    if args.action == 'destroy': return destroy(directory, value)
    run(directory, value, args.action)


if __name__ == '__main__':
    main()
