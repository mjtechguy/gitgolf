#!/usr/bin/env python3
"""Prepare a separate native Artifacts/D1 repository installation; provisions nothing."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlsplit

from cloudflare_setup import ROOT, hostname, private_write

# The same pattern as nativeWorkflowPath in cloudflare/forge/src/native-workflow.mjs, which the build applies.
ACTIONS_WORKFLOW_PATH = r'\.github/workflows/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.ya?ml'


def initialize(directory, account, host, worker, workspace, namespace, database_id, database_name, login, evidence=None, tests=None, analytics=None, agent_path=None, access_aud=None, owner_email=None, web_assets=None, previews=None, apps=None, automatic_ci=False, operations=None, webhooks=None, anonymous_rate_limit=None, execution_values=None):
    if operations is not None:
        if not isinstance(operations, dict) or set(operations) - {'analytics_secret', 'observability', 'service_health'}:
            raise ValueError('Invalid operations configuration')
        if 'service_health' in operations and type(operations['service_health']) is not bool:
            raise ValueError('Use an explicit service health policy')
        if 'analytics_secret' in operations:
            ref = operations['analytics_secret']
            if not isinstance(ref, dict) or set(ref) != {'store', 'name'} or not isinstance(ref['store'], str) or not re.fullmatch('[a-f0-9]{32}', ref['store']) or not isinstance(ref['name'], str) or not re.fullmatch('[A-Za-z0-9_-]{1,64}', ref['name']):
                raise ValueError('Use an approved Analytics Read secret reference')
        if 'observability' in operations:
            value = operations['observability']
            if not isinstance(value, dict) or set(value) != {'enabled', 'sampling'} or type(value['enabled']) is not bool or type(value['sampling']) not in (int, float) or not 0 <= value['sampling'] <= .1:
                raise ValueError('Use explicit observability sampling between 0 and 0.1')
    hostname(host)
    if not re.fullmatch('[a-f0-9]{32}', account) or not re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', database_id):
        raise ValueError('Canonical account and D1 identifiers required')
    if any(not re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', value) for value in [worker, namespace, database_name]):
        raise ValueError('Canonical Worker, namespace and database names required')
    if any(not re.fullmatch('[a-z0-9][a-z0-9_-]{0,62}', value) for value in [workspace, login]):
        raise ValueError('Canonical workspace and owner login required')
    if evidence is not None:
        if evidence.get('dead_letter') is not None and (not isinstance(evidence['dead_letter'], str) or not re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', evidence['dead_letter']) or evidence['dead_letter'] == evidence.get('queue')):
            raise ValueError('Use a separate approved dead-letter queue')
        if any(not isinstance(evidence.get(key), str) or not re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', evidence[key]) for key in ['bucket', 'queue', 'workflow']):
            raise ValueError('Allocate an evidence bucket, queue and workflow together')
        if type(evidence.get('daily_limit')) is not int or not 1 <= evidence['daily_limit'] <= 20 or type(evidence.get('allow_ai')) is not bool:
            raise ValueError('Explicit evidence limit 1-20 and AI policy required')
        if evidence['allow_ai'] and (not isinstance(evidence.get('gateway'), str) or not re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', evidence['gateway'])):
            raise ValueError('AI advice requires an allocated private AI Gateway')
    if tests is not None:
        if not isinstance(tests, dict) or set(tests) - {'module', 'workflow', 'image', 'image_id', 'build'} or evidence is None:
            raise ValueError('Container tests require an evidence allocation')
        workflow = tests.get('workflow')
        if workflow is not None:
            if not isinstance(workflow, dict) or set(workflow) != {'format', 'path'} or not (
                    workflow['format'] in ('actions', 'actions-act') and isinstance(workflow['path'], str) and
                    re.fullmatch(ACTIONS_WORKFLOW_PATH, workflow['path']) or
                    workflow['format'] == 'gitlab' and workflow['path'] == '.gitlab-ci.yml'):
                raise ValueError('Choose one approved native Actions or GitLab workflow path')
            if 'module' in tests and workflow['format'] != 'actions':
                raise ValueError('An approved module beside a workflow requires the hosted Actions shell profile')
        if (workflow is None or 'module' in tests) and (not isinstance(tests.get('module'), str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,8}', tests['module']) or len(tests['module']) > 128):
            raise ValueError('Container tests require an approved Python unittest module')
        if not isinstance(tests.get('image'), str) or not re.fullmatch(r'[a-z0-9][a-z0-9._/-]{0,127}:[a-z0-9][a-z0-9._-]{0,63}(?:@sha256:[a-f0-9]{64})?', tests['image']):
            raise ValueError('Explicit built container image tag or pinned digest required')
        if not isinstance(tests.get('image_id'), str) or not re.fullmatch('sha256:[a-f0-9]{64}', tests['image_id']):
            raise ValueError('Approved local Docker image ID required')
        if workflow is not None and workflow['format'] == 'actions-act' and '@sha256:' not in tests['image']:
            raise ValueError('Pinned Actions requires a digest-pinned approved image')
        if 'build' in tests and (tests['build'] is not True or workflow is None or workflow['format'] != 'actions-act'):
            raise ValueError('Socketless build requires the pinned Actions profile')
    if analytics is not None and (evidence is None or not isinstance(analytics, str) or not re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,63}', analytics)):
        raise ValueError('Evidence allocation and canonical Analytics Engine dataset required')
    if agent_path is not None and (tests is None or 'module' not in tests or evidence is None or not evidence['allow_ai'] or not isinstance(agent_path, str) or
            len(agent_path) > 200 or len(worker) > 56 or any(not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', p) or '..' in p for p in agent_path.split('/')) or
            agent_path == tests['module'].replace('.', '/') + '.py'):
        raise ValueError('Agent execution requires approved source path, container tests and private AI allocation')
    if access_aud is not None and (not re.fullmatch('[a-f0-9]{64}', access_aud) or not isinstance(owner_email, str) or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', owner_email) or len(owner_email) > 254):
        raise ValueError('Access requires its exact application audience and a mapped owner email')
    if owner_email is not None and (not isinstance(owner_email, str) or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', owner_email) or len(owner_email) > 254):
        raise ValueError('Canonical owner email required')
    if web_assets is not None and (access_aud is None or not (Path(web_assets)/'native.html').is_file()):
        raise ValueError('Native UI requires Access and a built native frontend')
    if previews is not None:
        if tests is None or evidence is None or access_aud is None:
            raise ValueError('Protected previews require passing-test allocation and Access login')
        hostname(previews.get('hostname', ''))
        if previews['hostname'] == host or not re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', previews.get('worker', '')) or previews['worker'] == worker or not re.fullmatch('[a-f0-9]{64}', previews.get('access_aud', '')) or type(previews.get('ttl')) is not int or not 60 <= previews['ttl'] <= 14400 or not isinstance(previews.get('path'), str) or len(previews['path']) > 200 or any(not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', p) or '..' in p for p in previews['path'].split('/')):
            raise ValueError('Explicit preview hostname, Worker, Access audience, source directory and TTL required')
        if 'browser' in previews and type(previews['browser']) is not bool or 'automatic' in previews and type(previews['automatic']) is not bool:
            raise ValueError('Preview browser and automatic policies must be explicit booleans')
    if type(automatic_ci) is not bool or automatic_ci and tests is None:
        raise ValueError('Automatic CI requires an approved test allocation')
    if apps is not None:
        if not isinstance(apps, dict) or not isinstance(apps.get('policy'), dict) or not isinstance(apps.get('provisioner'), dict):
            raise ValueError('Explicit managed application policy and credential reference required')
        p, credential = apps['policy'], apps['provisioner']
        if previews is None or len(worker) > 54 or type(apps.get('automatic')) is not bool or set(p) - {'namespace', 'entry', 'migration', 'ttl', 'zone', 'gateway', 'outbound', 'secret'}:
            raise ValueError('Managed applications require protected preview and explicit automatic policy')
        if not re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', (p.get('namespace', '') or '')) or p.get('gateway') != previews['worker'] or p.get('outbound') != worker + '-outbound' or not re.fullmatch('[a-f0-9]{32}', (p.get('zone', '') or '')) or type(p.get('ttl')) is not int or not 60 <= p['ttl'] <= 14400:
            raise ValueError('Explicit dispatch namespace, preview gateway, zone and bounded TTL required')
        for key, suffix in [('entry', '.mjs'), ('migration', '.sql')]:
            value = p.get(key)
            if not isinstance(value, str) or not value.endswith(suffix) or len(value) > 200 or any(not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', part) or '..' in part for part in value.split('/')):
                raise ValueError('Approve a prebundled Worker module and SQL schema path')
        if set(credential) != {'store', 'name'} or not re.fullmatch('[a-f0-9]{32}', (credential.get('store', '') or '')) or not re.fullmatch('[A-Za-z0-9_-]{1,64}', (credential.get('name', '') or '')):
            raise ValueError('Allocate a Secrets Store management credential; values never enter installation settings')
        if p.get('secret') is not None:
            secret = p['secret']
            if not isinstance(secret, dict) or set(secret) != {'store', 'name'} or not re.fullmatch('[a-f0-9]{32}', (secret.get('store', '') or '')) or not re.fullmatch('[A-Za-z0-9_-]{1,64}', (secret.get('name', '') or '')) or secret['name'] == credential['name']:
                raise ValueError('Application secret must be a distinct approved Secrets Store reference')
    if webhooks is not None:
        if not isinstance(webhooks, dict) or set(webhooks) != {'origins', 'dailyLimit', 'key'}:
            raise ValueError('Explicit approved webhook origins, dailyLimit and key reference required')
        ref, origins = webhooks['key'], webhooks['origins']
        if not isinstance(ref, dict) or set(ref) != {'store', 'name'} or not isinstance(ref['store'], str) or not re.fullmatch('[a-f0-9]{32}', ref['store']) or not isinstance(ref['name'], str) or not re.fullmatch('[A-Za-z0-9_-]{1,128}', ref['name']):
            raise ValueError('Use a Secrets Store webhook encryption key reference')
        if type(webhooks['dailyLimit']) is not int or not 1 <= webhooks['dailyLimit'] <= 5000 or not isinstance(origins, list) or not 1 <= len(origins) <= 32 or any(not isinstance(value, str) for value in origins) or len(set(origins)) != len(origins):
            raise ValueError('Use distinct HTTPS origins and a daily attempt limit between 1 and 5000')
        for origin in origins:
            parsed = urlsplit(origin)
            domain = parsed.hostname or ''
            if origin != 'https://' + domain or origin == 'https://' + host or len(domain) > 253 or not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*', domain) or any(len(part) > 63 or part.startswith('-') or part.endswith('-') for part in domain.split('.')) or re.search(r'(?:^|\.)(?:localhost|local|internal|invalid|test)$', domain) or domain.endswith('.home.arpa'):
                raise ValueError('Approve exact public HTTPS origins without paths, ports or credentials')
    if anonymous_rate_limit is not None:
        limit = anonymous_rate_limit
        if not isinstance(limit, dict) or set(limit) != {'namespace', 'limit', 'period'} or not isinstance(limit['namespace'], str) or not re.fullmatch('[1-9][0-9]{0,9}', limit['namespace']) or int(limit['namespace']) > 2147483647 or type(limit['limit']) is not int or not 10 <= limit['limit'] <= 10000 or limit['period'] not in (10, 60) or type(limit['period']) is not int:
            raise ValueError('Anonymous rate limit needs a positive integer namespace, a limit of 10 to 10000 and a period of 10 or 60 seconds')
    if execution_values is not None:
        ref = execution_values.get('key') if isinstance(execution_values, dict) else None
        if not isinstance(execution_values, dict) or set(execution_values) != {'key'} or not isinstance(ref, dict) or set(ref) != {'store', 'name'} or not isinstance(ref['store'], str) or not re.fullmatch('[a-f0-9]{32}', ref['store']) or not isinstance(ref['name'], str) or not re.fullmatch('[A-Za-z0-9_-]{1,128}', ref['name']):
            raise ValueError('Use a Secrets Store repository value encryption key reference')
        # Sharing a key would let one store's ciphertext be presented to another.
        used = [(webhooks or {}).get('key'), (apps or {}).get('provisioner'), ((apps or {}).get('policy') or {}).get('secret'), (operations or {}).get('analytics_secret')]
        if any(isinstance(other, dict) and other.get('store') == ref['store'] and other.get('name') == ref['name'] for other in used):
            raise ValueError('Repository values need their own encryption key, separate from every other secret reference')
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir(mode=0o700)  # Refuse existing installs instead of rotating authority.
    settings = {'account': account, 'worker': worker, 'namespace': namespace, 'workspace': workspace,
                'database': {'uuid': database_id, 'name': database_name}, 'origin': 'https://' + host,
                'hostname': host, 'workers_dev': False}
    if evidence is not None:
        settings['evidence'] = evidence
    if tests is not None:
        settings['tests'] = tests
    if agent_path is not None:
        settings['agent_path'] = agent_path
    if analytics is not None:
        settings['analytics_dataset'] = analytics
    if access_aud is not None:
        settings['access_aud'] = access_aud
    if web_assets is not None:
        settings['ui'] = True
        settings['web_assets'] = str(Path(web_assets).resolve())
    if previews is not None:
        settings['previews'] = {**previews, 'origin': 'https://' + previews['hostname']}
    if apps is not None:
        settings['apps'] = apps
    if operations is not None:
        settings['operations'] = operations
    if webhooks is not None:
        settings['webhooks'] = webhooks
    if execution_values is not None:
        settings['execution_values'] = execution_values
    if automatic_ci:
        settings['automatic_ci'] = True
    if anonymous_rate_limit is not None:
        settings['anonymous_rate_limit'] = anonymous_rate_limit
    token = 'golf_native_' + secrets.token_urlsafe(32)
    expires = int(time.time()) + 3600
    batch = [
        {'sql': (ROOT/'cloudflare/forge/schema.sql').read_text()},
        {'sql': 'INSERT INTO workspaces(slug,artifact_namespace) VALUES(?,?)', 'params': [workspace, namespace]},
        {'sql': 'INSERT INTO users(id,login,email,can_create) VALUES(1,?,?,1)', 'params': [login, owner_email]},
        {'sql': 'INSERT INTO operations_admins(user_id) VALUES(1)', 'params': []},
        {'sql': 'INSERT INTO credentials(digest,user_id,expires_at) VALUES(?,1,?)',
         'params': [hashlib.sha256(token.encode()).hexdigest(), expires]},
    ]
    for name, value in [('forge.json', settings), ('bootstrap.json', batch),
                        ('credential.json', {'token': token, 'expires_at': expires, 'user_id': '1'})]:
        private_write(directory/name, json.dumps(value, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT/'.cloudflare/native')
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--hostname', default='gitgolf.mjtechguy.com')
    parser.add_argument('--worker', default='gitgolf-native')
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--namespace', required=True)
    parser.add_argument('--database-id', required=True)
    parser.add_argument('--database-name', required=True)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--evidence-bucket')
    parser.add_argument('--evidence-queue')
    parser.add_argument('--evidence-workflow')
    parser.add_argument('--evidence-dead-letter-queue', help='Existing separate queue for durable failed-delivery observations')
    parser.add_argument('--evidence-daily-limit', type=int, default=2)
    parser.add_argument('--evidence-ai', action='store_true')
    parser.add_argument('--evidence-gateway')
    parser.add_argument('--test-module', help='Operator-approved Python unittest module; enables container tests')
    parser.add_argument('--test-workflow-format', choices=['actions', 'actions-act', 'gitlab'], help='Operator-approved PR workflow format')
    parser.add_argument('--test-workflow-path', help='Exact workflow path in each PR head')
    parser.add_argument('--test-socketless-build', action='store_true', help='Build a bounded OCI image after the pinned Actions job passes')
    parser.add_argument('--test-image', help='Built native container image tag, paired with a module or workflow')
    parser.add_argument('--test-image-id', help='Approved immutable local Docker image ID, sha256:HEX')
    parser.add_argument('--analytics-dataset', help='Optional Analytics Engine completion metrics; creates data on first event')
    parser.add_argument('--agent-path', help='Optional single approved source file; enables isolated native agent proposals')
    parser.add_argument('--access-aud', help='Existing control Access application audience; enables fail-closed Zero Trust login')
    parser.add_argument('--owner-email', help='Verified Access email mapped to the bootstrap Golf owner')
    parser.add_argument('--web-assets', type=Path, help='Built web/dist-native directory; requires Access')
    parser.add_argument('--preview-hostname', help='Dedicated preview hostname, separate from the control origin')
    parser.add_argument('--preview-worker')
    parser.add_argument('--preview-access-aud')
    parser.add_argument('--preview-path', help='Operator-approved static asset directory in the repository')
    parser.add_argument('--preview-ttl', type=int, default=900)
    parser.add_argument('--preview-browser-snapshots', action='store_true', help='Allocate one script-free Browser Run snapshot per preview')
    parser.add_argument('--preview-manual', action='store_true', help='Disable automatic publication after passing canonical tests')
    parser.add_argument('--automatic-ci', action='store_true', help='Admit bounded tests after confirmed eligible PR pushes')
    parser.add_argument('--webhooks-config', type=Path, help='JSON approved HTTPS origins, dailyLimit and key {store,name}; never a secret value')
    parser.add_argument('--execution-value-key-store', help='Existing Secrets Store ID holding the dedicated repository value encryption key')
    parser.add_argument('--execution-value-key-name', help='Existing 32-byte base64 key secret name; never pass its value and never reuse the webhook key')
    parser.add_argument('--app-namespace', help='Existing Workers for Platforms dispatch namespace; paid entitlement required')
    parser.add_argument('--app-entry', help='Approved prebundled .mjs entry in immutable Artifacts source')
    parser.add_argument('--app-migration', help='Approved .sql schema for a disposable preview D1 database')
    parser.add_argument('--app-zone', help='Existing preview zone ID; custom domains are owned per preview')
    parser.add_argument('--app-ttl', type=int, default=3600)
    parser.add_argument('--app-provisioner-store', help='Existing Secrets Store ID containing a scoped management token')
    parser.add_argument('--app-provisioner-name', help='Existing management secret name; never pass its value')
    parser.add_argument('--app-secret-store', help='Optional separate application secret store ID')
    parser.add_argument('--app-secret-name', help='Optional approved application secret name')
    parser.add_argument('--app-manual', action='store_true', help='Disable automatic Worker application publication')
    parser.add_argument('--anonymous-rate-limit', type=int, help='Approximate anonymous public read/clone requests per period for each client network and Cloudflare location; needs a namespace')
    parser.add_argument('--anonymous-rate-period', type=int, default=60, help='Counting period in seconds, 10 or 60')
    parser.add_argument('--anonymous-rate-namespace', help='Positive integer naming this limiter, unique within the Cloudflare account')
    parser.add_argument('--operations-analytics-store', help='Existing Secrets Store ID containing an account-scoped Analytics Read token')
    parser.add_argument('--operations-analytics-name', help='Existing read-only analytics secret name; never its value')
    parser.add_argument('--operations-service-health', action='store_true', help='Enable bounded read-only R2/Artifacts health probes')
    parser.add_argument('--operations-observability', action='store_true', help='Enable bounded structured Worker logs; no Grafana deployment')
    parser.add_argument('--operations-sampling', type=float, default=.1, help='Managed log sampling, maximum 0.1')
    args = parser.parse_args()
    try:
        operations = {'service_health': True} if args.operations_service_health else {}
        if args.operations_analytics_store or args.operations_analytics_name:
            operations['analytics_secret'] = {'store': args.operations_analytics_store, 'name': args.operations_analytics_name}
        if args.operations_observability:
            operations['observability'] = {'enabled': True, 'sampling': args.operations_sampling}
        evidence = None
        if any([args.evidence_bucket, args.evidence_queue, args.evidence_workflow, args.evidence_ai, args.evidence_gateway, args.evidence_dead_letter_queue]):
            evidence = {'bucket': args.evidence_bucket, 'queue': args.evidence_queue, 'workflow': args.evidence_workflow,
                        'daily_limit': args.evidence_daily_limit, 'allow_ai': args.evidence_ai, 'gateway': args.evidence_gateway}
            if args.evidence_dead_letter_queue:
                evidence['dead_letter'] = args.evidence_dead_letter_queue
        tests = {'image': args.test_image, 'image_id': args.test_image_id,
                 **({'module': args.test_module} if args.test_module else {}),
                 **({'workflow': {'format': args.test_workflow_format, 'path': args.test_workflow_path}} if args.test_workflow_format or args.test_workflow_path else {}),
                 **({'build': True} if args.test_socketless_build else {})}
        if not any([args.test_module, args.test_workflow_format, args.test_workflow_path, args.test_image, args.test_image_id, args.test_socketless_build]):
            tests = None
        previews = None
        if any([args.preview_hostname, args.preview_worker, args.preview_access_aud, args.preview_path, args.preview_browser_snapshots, args.preview_manual]):
            previews = {'hostname': args.preview_hostname, 'worker': args.preview_worker, 'access_aud': args.preview_access_aud, 'path': args.preview_path, 'ttl': args.preview_ttl, 'browser': args.preview_browser_snapshots, 'automatic': not args.preview_manual}
        apps = None
        if any([args.app_namespace, args.app_entry, args.app_migration, args.app_zone, args.app_provisioner_store, args.app_provisioner_name, args.app_secret_store, args.app_secret_name, args.app_manual]):
            policy = {'namespace': args.app_namespace, 'entry': args.app_entry, 'migration': args.app_migration, 'ttl': args.app_ttl, 'zone': args.app_zone, 'gateway': args.preview_worker, 'outbound': args.worker + '-outbound'}
            if args.app_secret_store or args.app_secret_name:
                policy['secret'] = {'store': args.app_secret_store, 'name': args.app_secret_name}
            apps = {'policy': policy, 'provisioner': {'store': args.app_provisioner_store, 'name': args.app_provisioner_name}, 'automatic': not args.app_manual}
        rate_limit = None
        if args.anonymous_rate_limit is not None or args.anonymous_rate_namespace:
            rate_limit = {'namespace': args.anonymous_rate_namespace, 'limit': args.anonymous_rate_limit, 'period': args.anonymous_rate_period}
        initialize(args.directory, args.account_id, args.hostname, args.worker, args.workspace,
                   args.namespace, args.database_id, args.database_name, args.owner, evidence, tests, args.analytics_dataset, args.agent_path,
                   args.access_aud, args.owner_email, args.web_assets, previews, apps, args.automatic_ci, operations or None, json.loads(args.webhooks_config.read_text()) if args.webhooks_config else None, rate_limit,
                   {'key': {'store': args.execution_value_key_store, 'name': args.execution_value_key_name}} if args.execution_value_key_store or args.execution_value_key_name else None)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')
    print('Private native configuration prepared; no resources provisioned. Bootstrap credential expires in one hour.')


if __name__ == '__main__':
    main()
