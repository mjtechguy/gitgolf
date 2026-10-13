#!/usr/bin/env python3
"""Release the prepared native installation without changing database or resource ownership."""
import argparse
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import fcntl
import base64
import time

from cloudflare_setup import private_write, replace_private_json

ROOT = Path(__file__).resolve().parents[1]
ASSET = re.compile(r'ui-assets/assets/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|svg)')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')


def load_release(directory):
    root = Path(directory).resolve()
    settings = json.loads((root / 'forge.json').read_text())
    manifest = json.loads((root / 'release-manifest.json').read_text())
    identities = {'account': settings['account'], 'worker': settings['worker'], 'database': settings['database']['uuid'],
                  'namespace': settings['namespace'], 'workspace': settings['workspace'], 'origin': settings['origin'], 'bucket': settings['evidence']['bucket']}
    if any(manifest.get(key) != value for key, value in identities.items()) or manifest.get('format') != 1 or manifest.get('schema') not in (10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20) or manifest.get('contract') != 1:
        raise ValueError('Release identity or contract differs from the prepared installation')
    for key in ['release', 'bundleSha256', 'previousBundleSha256']:
        if not re.fullmatch('[a-f0-9]{64}', manifest.get(key, '')):
            raise ValueError('Invalid release digest')
    if not 1 <= len(manifest['assets']) <= 384:
        raise ValueError('Release asset inventory exceeds its bound')
    for path, asset in manifest['assets'].items():
        if asset['key'] != 'ui-assets' + path or not ASSET.fullmatch(asset['key']) or not re.fullmatch('[a-f0-9]{64}', asset['sha256']) or not 0 <= asset['bytes'] <= 4 * 1024 * 1024:
            raise ValueError('Invalid retained asset')
        data = (root / 'releases' / (asset['sha256'] + '.asset')).read_bytes()
        if hashlib.sha256(data).hexdigest() != asset['sha256'] or len(data) != asset['bytes']:
            raise ValueError('Retained asset bytes changed')
    bundle = root / '.cloudflare/output/v0/workers/default/bundle/worker.mjs'
    if hashlib.sha256(bundle.read_bytes()).hexdigest() != manifest['bundleSha256']:
        raise ValueError('Prepared bundle changed after release review')
    return root, settings, manifest


class Release:
    def __init__(self, directory, profile='golf'):
        self.root, self.settings, self.manifest = load_release(directory)
        if not re.fullmatch('[a-zA-Z0-9_-]{1,63}', profile) or any(os.environ.get(key) for key in ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY']):
            raise ValueError('Use a named CLI profile without ambient credential overrides')
        self.profile = profile
        self.env = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': self.manifest['account'], 'CF_SEND_TELEMETRY': 'false', 'CI': 'true'}
        self.path = self.root / 'release-journal.json'
        self.guard = (self.root / 'release.lock').open('a')
        os.chmod(self.guard.name, 0o600)
        fcntl.flock(self.guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {'account': self.manifest['account'], 'worker': self.manifest['worker'], 'bucket': self.manifest['bucket'], 'assets': {}, 'releases': {}}
        if any(self.state.get(key) != self.manifest[key] for key in ['account', 'worker', 'bucket']):
            raise ValueError('Release journal belongs to another installation')
        self.lock = threading.Lock()

    def save(self):
        replace_private_json(self.path, self.state)

    def command(self, *args, missing=False, raw=False, timeout=60):
        attempts = 3 if args[:3] == ('r2', 'objects', 'get') else 1
        for attempt in range(attempts):
            try:
                process = subprocess.run([shutil.which('cf'), '--profile', self.profile, *args], cwd=self.root, env=self.env, capture_output=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                if attempt + 1 == attempts:
                    raise RuntimeError('Cloudflare release operation timed out: ' + ' '.join(args[:3])) from None
            else:
                if not process.returncode:
                    return process.stdout if raw else json.loads(process.stdout)
                if missing and b'404 Not Found' in process.stderr:
                    return None
                private_write(self.root / ('release-command-error-' + str(time.time_ns()) + '.log'), process.stderr.decode(errors='replace'))
                transient = re.search(rb'\b(?:429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b', process.stderr)
                if not transient or attempt + 1 == attempts:
                    raise RuntimeError('Cloudflare release operation failed: ' + ' '.join(args[:3]))
            time.sleep(attempt + 1)

    def check(self):
        result = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(repositories)')
        if not any(row['name'] == 'default_branch' for row in result[0]['results']):
            raise ValueError('Apply the additive 0007 migration before releasing; no database rollback is performed')
        columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(repository_indexes)')[0]['results']
        if not {'key', 'payload_hash', 'state', 'expires_at'}.issubset({row['name'] for row in columns}):
            raise ValueError('Apply the additive 0008 repository-index migration before releasing')
        columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(repository_index_budget)')[0]['results']
        if not {'day', 'operations'}.issubset({row['name'] for row in columns}):
            raise ValueError('Apply the additive 0009 metadata-budget migration before releasing')
        for table, required in [('operations_admins', {'user_id', 'active'}), ('operations_maintenance', {'stage', 'started_at', 'completed_at', 'last_success_at', 'outcome', 'processed', 'pending'}), ('operations_provider', {'service', 'attempted_at', 'state', 'requests', 'errors', 'subrequests'}), ('operations_delivery_failures', {'message_id', 'job_id', 'observed_at'})]:
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not required.issubset({row['name'] for row in columns}):
                raise ValueError('Apply additive 0010 operations migration before releasing')
        if self.manifest['schema'] >= 11:
            self.check_access_schema()
        if self.manifest['schema'] >= 12:
            self.check_invitation_schema()
        if self.manifest['schema'] >= 13:
            self.check_discussion_schema()
        if self.manifest['schema'] >= 14:
            self.check_engagement_schema()
        if self.manifest['schema'] >= 15:
            self.check_webhook_schema()
        if self.manifest['schema'] >= 16:
            self.check_rules_schema()
        if self.manifest['schema'] >= 17:
            self.check_git_credentials_schema()
        if self.manifest['schema'] >= 18:
            self.check_pull_reviews_schema()
        if self.manifest['schema'] >= 19:
            self.check_runner_schema()
        deployments = self.command('workers', 'deployments', 'list', '--worker', self.manifest['worker'], '--per-page', '1')
        deployment = deployments[0] if isinstance(deployments, list) else deployments['deployments'][0]
        versions = deployment['versions']
        if len(versions) != 1 or versions[0]['percentage'] != 100 or not UUID.fullmatch(versions[0]['version_id']):
            raise ValueError('Complete the current gradual deployment before starting another release')
        current = self.command('workers', 'versions', 'get', versions[0]['version_id'], '--worker-id', self.manifest['worker'], '--include', 'modules')
        modules = current['modules']
        bundle = next(module for module in modules if module['name'] == 'worker.mjs')['content_base64'] if isinstance(modules, list) else modules['worker.mjs']['content_base64']
        expected = self.manifest['bundleSha256'] if self.state['releases'].get(self.manifest['release'], {}).get('state') == 'deployed' else self.manifest['previousBundleSha256']
        if hashlib.sha256(base64.b64decode(bundle, validate=True)).hexdigest() != expected:
            raise ValueError('Live release differs from the reviewed predecessor; deployment refused')
        return versions[0]['version_id']

    def migrate(self):
        applied = []
        for number, table, required, filename in [
            ('0008', 'repository_indexes', {'key', 'payload_hash', 'state', 'expires_at'}, '0008_repository_indexes.sql'),
            ('0009', 'repository_index_budget', {'day', 'operations'}, '0009_repository_index_budget.sql'),
        ]:
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if columns:
                if not required.issubset({row['name'] for row in columns}):
                    raise ValueError('Existing index table differs from the expected schema')
                continue
            sql = (ROOT / 'cloudflare/forge/migrations' / filename).read_text()
            statements = [part.strip() for part in re.sub(r'--[^\n]*', '', sql).split(';') if part.strip()]
            if not statements or any(not re.match(r'CREATE (?:TABLE ' + table + r'|INDEX repository_indexes_expiry)\b', statement) for statement in statements):
                raise ValueError('Migration must only add the reviewed index table and index')
            self.command('d1', 'query', self.manifest['database'], '--sql', ';\n'.join(statements) + ';')
            self.state['migration' + number] = hashlib.sha256(sql.encode()).hexdigest(); self.save()
            applied.append(number)
        # IF NOT EXISTS permits recovery after any individual additive statement.
        required = {'operations_delivery_failures': {'message_id', 'job_id', 'observed_at'}, 'operations_provider': {'service', 'attempted_at', 'state', 'requests', 'errors', 'subrequests'}, 'operations_admins': {'user_id', 'active'}, 'operations_maintenance': {'stage', 'started_at', 'completed_at', 'last_success_at', 'outcome', 'processed', 'pending'}}
        for table, fields in required.items():
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if columns and not fields.issubset({row['name'] for row in columns}):
                raise ValueError('Existing operations table differs from reviewed schema')
        sql = (ROOT / 'cloudflare/forge/migrations/0010_operations.sql').read_text()
        statements = [part.strip() for part in re.sub(r'--[^\n]*', '', sql).split(';') if part.strip()]
        reviewed = r'CREATE (?:TABLE IF NOT EXISTS operations_(?:admins|maintenance|provider|delivery_failures)|INDEX IF NOT EXISTS (?:evidence_operations|app_resources_operations|operations_delivery_expiry))\b'
        if len(statements) != 7 or any(not re.match(reviewed, statement) for statement in statements):
            raise ValueError('Operations migration must only add reviewed tables and indexes')
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0010') not in (None, digest):
            raise ValueError('Recorded operations migration differs from reviewed source')
        if 'migration0010' not in self.state or any(not self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results'] for table in required):
            self.command('d1', 'query', self.manifest['database'], '--sql', ';\n'.join(statements) + ';')
            for table, fields in required.items():
                columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
                if not fields.issubset({row['name'] for row in columns}):
                    raise ValueError('Operations migration readback failed')
            self.state['migration0010'] = hashlib.sha256(sql.encode()).hexdigest(); self.save(); applied.append('0010')
        if self.manifest['schema'] >= 11:
            self.migrate_access(applied)
        if self.manifest['schema'] >= 12:
            self.migrate_invitations(applied)
        if self.manifest['schema'] >= 13:
            self.migrate_discussions(applied)
        if self.manifest['schema'] >= 14:
            self.migrate_engagement(applied)
        if self.manifest['schema'] >= 15:
            self.migrate_webhooks(applied)
        if self.manifest['schema'] >= 16:
            self.migrate_rules(applied)
        if self.manifest['schema'] >= 17:
            self.migrate_git_credentials(applied)
        if self.manifest['schema'] >= 18:
            self.migrate_pull_reviews(applied)
        if self.manifest['schema'] >= 19:
            self.migrate_runner_schema(applied)
        return applied or 'already-applied'

    def check_access_schema(self):
        required = {'repository_access_versions': {'repository_id', 'version'},
                    'collaborator_versions': {'repository_id', 'user_id', 'generation'},
                    'repository_access_operations': {'actor_id', 'operation_key', 'repository_id', 'recipient_id', 'input_hash', 'receipt'}}
        for table, fields in required.items():
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not fields.issubset({row['name'] for row in columns}):
                raise ValueError('Apply additive 0011 repository access migration before releasing')
        triggers = self.command('d1', 'query', self.manifest['database'], '--sql', "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='grants'")[0]['results']
        if not {'grants_insert_revision', 'grants_update_revision', 'grants_delete_revision'}.issubset({row['name'] for row in triggers}):
            raise ValueError('Repository access revision triggers are missing')

    def migrate_access(self, applied):
        sql = (ROOT / 'cloudflare/forge/migrations/0011_repository_access.sql').read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0011') not in (None, digest):
            raise ValueError('Recorded repository access migration differs from reviewed source')
        # sqlite3 preserves trigger bodies when separating complete SQL statements.
        statements, pending = [], ''
        for line in re.sub(r'--[^\n]*', '', sql).splitlines(keepends=True):
            pending += line
            if sqlite3.complete_statement(pending):
                statements.append(pending.strip()); pending = ''
        reviewed = r'CREATE (?:TABLE IF NOT EXISTS (?:repository_access_versions|collaborator_versions|repository_access_operations)|TRIGGER IF NOT EXISTS grants_(?:insert|update|delete)_revision)\b'
        if pending.strip() or len(statements) != 6 or any(not re.match(reviewed, statement) for statement in statements):
            raise ValueError('Repository access migration must only add reviewed tables and triggers')
        ready = False
        try:
            self.check_access_schema(); ready = True
        except ValueError:
            pass
        if 'migration0011' not in self.state or not ready:
            self.command('d1', 'query', self.manifest['database'], '--sql', '\n'.join(statements))
            self.check_access_schema()
            self.state['migration0011'] = digest; self.save(); applied.append('0011')

    def check_invitation_schema(self):
        required = {
            'native_identity_versions': {'user_id', 'version'},
            'repository_invitations': {'id', 'repository_id', 'artifact_name', 'issuer_id', 'issuer_version', 'issuer_generation', 'recipient_id', 'recipient_version', 'recipient_generation', 'permission', 'expires_at', 'created_at', 'revision', 'state', 'operation_key', 'input_hash'},
            'repository_invitation_operations': {'actor_id', 'operation_key', 'invitation_id', 'input_hash', 'receipt'},
        }
        for table, fields in required.items():
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not fields.issubset({row['name'] for row in columns}):
                raise ValueError('Apply additive 0012 repository invitation migration before releasing')
        objects = self.command('d1', 'query', self.manifest['database'], '--sql', "SELECT name FROM sqlite_master WHERE type IN ('trigger','index')")[0]['results']
        if not {'native_identity_revision', 'repository_invitation_pending', 'repository_invitation_inbox', 'repository_invitation_inventory'}.issubset({row['name'] for row in objects}):
            raise ValueError('Repository invitation trigger or indexes are missing')

    def migrate_invitations(self, applied):
        sql = (ROOT / 'cloudflare/forge/migrations/0012_repository_invitations.sql').read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0012') not in (None, digest):
            raise ValueError('Recorded invitation migration differs from reviewed source')
        statements, pending = [], ''
        for line in re.sub(r'--[^\n]*', '', sql).splitlines(keepends=True):
            pending += line
            if sqlite3.complete_statement(pending):
                statements.append(pending.strip()); pending = ''
        reviewed = r'CREATE (?:TABLE IF NOT EXISTS (?:native_identity_versions|repository_invitations|repository_invitation_operations)|TRIGGER IF NOT EXISTS native_identity_revision|(?:UNIQUE )?INDEX IF NOT EXISTS repository_invitation_(?:pending|inbox|inventory))\b'
        if pending.strip() or len(statements) != 7 or any(not re.match(reviewed, statement) for statement in statements):
            raise ValueError('Invitation migration must only add reviewed tables, trigger and indexes')
        ready = False
        try:
            self.check_invitation_schema(); ready = True
        except ValueError:
            pass
        if 'migration0012' not in self.state or not ready:
            self.command('d1', 'query', self.manifest['database'], '--sql', '\n'.join(statements))
            self.check_invitation_schema()
            self.state['migration0012'] = digest; self.save(); applied.append('0012')

    def check_discussion_schema(self):
        required = {
            'discussion_resources': {'id', 'repository_id', 'kind', 'name', 'payload', 'revision', 'deleted'},
            'discussion_resource_operations': {'actor_id', 'operation_key', 'repository_id', 'input_hash', 'receipt'},
            'discussion_labels': {'discussion_id', 'label_id'},
            'discussion_assignees': {'discussion_id', 'user_id'},
            'discussion_milestones': {'discussion_id', 'milestone_id'},
        }
        for table, fields in required.items():
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not fields.issubset({row['name'] for row in columns}):
                raise ValueError('Apply additive 0013 discussion resources migration before releasing')
        objects = self.command('d1', 'query', self.manifest['database'], '--sql', "SELECT name FROM sqlite_master WHERE type IN ('trigger','index')")[0]['results']
        required_objects = {'discussion_resource_name', 'discussion_resource_inventory', 'discussion_resource_revision', 'discussion_label_members', 'discussion_assignee_members', 'discussion_milestone_members'}
        if not required_objects.issubset({row['name'] for row in objects}):
            raise ValueError('Discussion resource trigger or indexes are missing')

    def migrate_discussions(self, applied):
        sql = (ROOT / 'cloudflare/forge/migrations/0013_discussion_resources.sql').read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0013') not in (None, digest):
            raise ValueError('Recorded discussion migration differs from reviewed source')
        statements, pending = [], ''
        for line in re.sub(r'--[^\n]*', '', sql).splitlines(keepends=True):
            pending += line
            if sqlite3.complete_statement(pending):
                statements.append(pending.strip()); pending = ''
        reviewed = r'CREATE (?:TABLE IF NOT EXISTS discussion_(?:resources|resource_operations|labels|assignees|milestones)|TRIGGER IF NOT EXISTS discussion_resource_revision|(?:UNIQUE )?INDEX IF NOT EXISTS discussion_(?:resource_name|resource_inventory|label_members|assignee_members|milestone_members))\b'
        if pending.strip() or len(statements) != 11 or any(not re.match(reviewed, statement) for statement in statements):
            raise ValueError('Discussion migration must only add reviewed tables, trigger and indexes')
        ready = False
        try:
            self.check_discussion_schema(); ready = True
        except ValueError:
            pass
        if 'migration0013' not in self.state or not ready:
            self.command('d1', 'query', self.manifest['database'], '--sql', '\n'.join(statements))
            self.check_discussion_schema()
            self.state['migration0013'] = digest; self.save(); applied.append('0013')

    def check_engagement_schema(self):
        required = {
            'discussion_engagement_versions': {'discussion_id', 'comment_id', 'version'},
            'discussion_reactions': {'discussion_id', 'comment_id', 'user_id', 'content'},
            'discussion_subscriptions': {'discussion_id', 'user_id'},
            'discussion_events': {'id', 'discussion_id', 'actor_id', 'kind', 'payload', 'created_at'},
            'discussion_notifications': {'id', 'user_id', 'discussion_id', 'event_id', 'unread', 'revision', 'created_at'},
        }
        for table, fields in required.items():
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not fields.issubset({row['name'] for row in columns}):
                raise ValueError('Apply additive 0014 discussion engagement migration before releasing')
        objects = self.command('d1', 'query', self.manifest['database'], '--sql', "SELECT name FROM sqlite_master WHERE type IN ('trigger','index')")[0]['results']
        required_objects = {'discussion_event_inventory', 'discussion_notification_inbox', 'discussion_reaction_added', 'discussion_reaction_removed', 'discussion_subscription_added', 'discussion_subscription_removed', 'discussion_comment_engagement_removed'}
        if not required_objects.issubset({row['name'] for row in objects}):
            raise ValueError('Discussion engagement triggers or indexes are missing')

    def migrate_engagement(self, applied):
        sql = (ROOT / 'cloudflare/forge/migrations/0014_discussion_engagement.sql').read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0014') not in (None, digest):
            raise ValueError('Recorded engagement migration differs from reviewed source')
        statements, pending = [], ''
        for line in re.sub(r'--[^\n]*', '', sql).splitlines(keepends=True):
            pending += line
            if sqlite3.complete_statement(pending):
                statements.append(pending.strip()); pending = ''
        reviewed = r'CREATE (?:TABLE IF NOT EXISTS discussion_(?:engagement_versions|reactions|subscriptions|events|notifications)|TRIGGER IF NOT EXISTS discussion_(?:reaction_added|reaction_removed|subscription_added|subscription_removed|comment_engagement_removed)|INDEX IF NOT EXISTS discussion_(?:event_inventory|notification_inbox))\b'
        if pending.strip() or len(statements) != 12 or any(not re.match(reviewed, statement) for statement in statements):
            raise ValueError('Engagement migration must only add reviewed tables, triggers and indexes')
        ready = False
        try:
            self.check_engagement_schema(); ready = True
        except ValueError:
            pass
        if 'migration0014' not in self.state or not ready:
            self.command('d1', 'query', self.manifest['database'], '--sql', '\n'.join(statements))
            self.check_engagement_schema()
            self.state['migration0014'] = digest; self.save(); applied.append('0014')

    def check_webhook_schema(self):
        required = {
            'webhook_subscriptions': {'id', 'repository_id', 'artifact_name', 'version', 'encrypted', 'credential_version', 'event_topics', 'workflow_notifications', 'enabled', 'sponsor_id', 'identity_version', 'grant_generation'},
            'webhook_deliveries': {'id', 'subscription_id', 'subscription_version', 'event_id', 'event_topic', 'payload', 'automatic_key', 'requested_by', 'input_hash', 'state', 'attempts', 'lease', 'lease_until', 'next_attempt_at', 'possible_duplicate'},
            'webhook_daily': {'day', 'attempts'},
            'webhook_maintenance': {'stage', 'started_at', 'completed_at', 'last_success_at', 'outcome', 'processed', 'pending'},
        }
        for table, fields in required.items():
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not fields.issubset({row['name'] for row in columns}):
                raise ValueError('Apply additive 0015 webhook migration before releasing')
        objects = self.command('d1', 'query', self.manifest['database'], '--sql', "SELECT name FROM sqlite_master WHERE name LIKE 'webhook_%' AND type IN ('trigger','index')")[0]['results']
        expected = {'webhook_repository', 'webhook_delivery_inventory', 'webhook_delivery_due', 'webhook_discussion_event', 'webhook_source_event', 'webhook_test_admission_event', 'webhook_test_state_event'}
        if not expected.issubset({row['name'] for row in objects}):
            raise ValueError('Webhook outbox triggers or indexes are missing')

    def migrate_webhooks(self, applied):
        sql = (ROOT / 'cloudflare/forge/migrations/0015_repository_webhooks.sql').read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0015') not in (None, digest):
            raise ValueError('Recorded webhook migration differs from reviewed source')
        statements, pending = [], ''
        for line in re.sub(r'--[^\n]*', '', sql).splitlines(keepends=True):
            pending += line
            if sqlite3.complete_statement(pending):
                statements.append(pending.strip()); pending = ''
        reviewed = r'CREATE (?:TABLE IF NOT EXISTS webhook_(?:subscriptions|deliveries|daily|maintenance)|INDEX IF NOT EXISTS webhook_(?:repository|delivery_inventory|delivery_due)|TRIGGER IF NOT EXISTS webhook_(?:discussion|source|test_admission|test_state)_event)\b'
        if pending.strip() or len(statements) != 11 or any(not re.match(reviewed, statement) for statement in statements):
            raise ValueError('Webhook migration must only add reviewed outbox tables, indexes and triggers')
        ready = False
        try:
            self.check_webhook_schema(); ready = True
        except ValueError:
            pass
        if 'migration0015' not in self.state or not ready:
            self.command('d1', 'query', self.manifest['database'], '--sql', '\n'.join(statements))
            self.check_webhook_schema()
            self.state['migration0015'] = digest; self.save(); applied.append('0015')

    def check_rules_schema(self):
        for table, required in {
            'repository_rules': {'repository_id', 'artifact_name', 'version', 'branches', 'tags', 'next_tag'},
            'repository_rule_operations': {'operation_id', 'repository_id', 'actor_id', 'input_hash', 'receipt', 'current_rules'},
        }.items():
            rows = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not required.issubset({row['name'] for row in rows}):
                raise ValueError('Apply additive 0016 repository rules migration before releasing')

    def migrate_rules(self, applied):
        sql = (ROOT / 'cloudflare/forge/migrations/0016_repository_rules.sql').read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0016') not in (None, digest):
            raise ValueError('Recorded rules migration differs from reviewed source')
        statements = [s.strip() for s in re.sub(r'--[^\n]*', '', sql).split(';') if s.strip()]
        if len(statements) != 2 or any(not re.match(r'CREATE TABLE IF NOT EXISTS repository_(?:rules|rule_operations)\b', s) for s in statements):
            raise ValueError('Rules migration must only add the reviewed policy and receipt tables')
        ready = False
        try:
            self.check_rules_schema(); ready = True
        except ValueError:
            pass
        if 'migration0016' not in self.state or not ready:
            self.command('d1', 'query', self.manifest['database'], '--sql', ';\n'.join(statements) + ';')
            self.check_rules_schema()
            self.state['migration0016'] = digest; self.save(); applied.append('0016')

    def check_git_credentials_schema(self):
        rows = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(git_credentials)')[0]['results']
        if not {'id','digest','user_id','repository_id','artifact_name','label','mode','identity_version','grant_generation','created_at','expires_at','revoked_at'}.issubset({row['name'] for row in rows}):
            raise ValueError('Apply additive 0017 Git credentials migration before releasing')
        indexes = self.command('d1', 'query', self.manifest['database'], '--sql', "SELECT name FROM sqlite_master WHERE type='index' AND name='git_credentials_inventory'")[0]['results']
        if not indexes:
            raise ValueError('Apply 0017 Git credentials inventory index before releasing')

    def migrate_git_credentials(self, applied):
        sql = (ROOT / 'cloudflare/forge/migrations/0017_git_credentials.sql').read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0017') not in (None, digest):
            raise ValueError('Recorded Git credentials migration differs from reviewed source')
        statements = [s.strip() for s in re.sub(r'--[^\n]*', '', sql).split(';') if s.strip()]
        if len(statements) != 2 or not statements[0].startswith('CREATE TABLE IF NOT EXISTS git_credentials (') or not statements[1].startswith('CREATE INDEX IF NOT EXISTS git_credentials_inventory ON git_credentials('):
            raise ValueError('Git credentials migration must only add the reviewed table and inventory index')
        ready = False
        try:
            self.check_git_credentials_schema(); ready = True
        except ValueError:
            pass
        if 'migration0017' not in self.state or not ready:
            self.command('d1', 'query', self.manifest['database'], '--sql', ';\n'.join(statements) + ';')
            self.check_git_credentials_schema()
            self.state['migration0017'] = digest; self.save(); applied.append('0017')

    def check_pull_reviews_schema(self):
        required = {'pull_review_versions': {'pull_request_id','version'},
                    'pull_review_requests': {'pull_request_id','user_id','identity_version','grant_generation'},
                    'pull_review_lifecycle': {'review_id','version','dismissed','reason','updated_at'},
                    'pull_review_operations': {'actor_id','operation_id','repository_id','pull_request_id','kind','input_hash','receipt'},
                    'pull_review_drafts': {'review_id','pull_request_id','author_id','status','updated_at'},
                    'pull_review_draft_versions': {'pull_request_id','author_id','version'}}
        for table, fields in required.items():
            rows = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not fields.issubset({row['name'] for row in rows}):
                raise ValueError('Apply additive 0018 pull reviews migration before releasing')

        indexes = self.command('d1','query',self.manifest['database'],'--sql',"SELECT name FROM sqlite_master WHERE type='index' AND name='pull_review_one_pending'")[0]['results']
        if not indexes:
            raise ValueError('Apply 0018 pending review uniqueness index before releasing')

    def migrate_pull_reviews(self, applied):
        sql = (ROOT / 'cloudflare/forge/migrations/0018_pull_reviews.sql').read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        if self.state.get('migration0018') not in (None, digest):
            raise ValueError('Recorded pull reviews migration differs from reviewed source')
        statements = [s.strip() for s in re.sub(r'--[^\n]*', '', sql).split(';') if s.strip()]
        tables = ['pull_review_versions','pull_review_requests','pull_review_lifecycle','pull_review_operations','pull_review_drafts','pull_review_draft_versions']
        expected = ['CREATE TABLE IF NOT EXISTS '+table+' (' for table in tables]
        expected.insert(5, 'CREATE UNIQUE INDEX IF NOT EXISTS pull_review_one_pending ON pull_review_drafts(')
        if len(statements) != len(expected) or any(not statement.startswith(prefix) for statement,prefix in zip(statements,expected)):
            raise ValueError('Pull reviews migration must only add the reviewed tables')
        ready = False
        try:
            self.check_pull_reviews_schema(); ready = True
        except ValueError:
            pass
        if 'migration0018' not in self.state or not ready:
            self.command('d1', 'query', self.manifest['database'], '--sql', ';\n'.join(statements) + ';')
            self.check_pull_reviews_schema()
            self.state['migration0018'] = digest; self.save(); applied.append('0018')

    def check_runner_schema(self, version=None):
        version = self.manifest['schema'] if version is None else version
        required = {
            'native_runner_pools': {'id', 'version', 'max_parallel', 'image_id'},
            'native_runner_machines': {'id', 'credential_digest', 'lease_digest', 'cleanup_state'},
            'native_runner_placements': {'repository_id', 'pool_id', 'pool_version', 'version'},
        }
        if version >= 20:
            required['native_runner_machines'].add('protocol')
            required['gitlab_runner_jobs'] = {'id', 'evidence_job_id', 'machine_id', 'token_digest', 'trace', 'trace_bytes', 'completed_state', 'completed_exit_code'}
        for table, fields in required.items():
            columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(' + table + ')')[0]['results']
            if not fields.issubset({row['name'] for row in columns}):
                raise ValueError('Apply additive 0019/0020 runner migrations before releasing')
        indexes = self.command('d1', 'query', self.manifest['database'], '--sql', "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('native_runner_machine_pool','gitlab_runner_jobs_machine')")[0]['results']
        expected = {'native_runner_machine_pool'} | ({'gitlab_runner_jobs_machine'} if version >= 20 else set())
        if not expected.issubset({row['name'] for row in indexes}):
            raise ValueError('Runner migration index is missing')

    def migrate_runner_schema(self, applied):
        for number, filename, prefixes in [
            ('0019', '0019_native_runners.sql', ['CREATE TABLE IF NOT EXISTS native_runner_pools (', 'CREATE TABLE IF NOT EXISTS native_runner_machines (', 'CREATE INDEX IF NOT EXISTS native_runner_machine_pool ', 'CREATE TABLE IF NOT EXISTS native_runner_placements (']),
            ('0020', '0020_gitlab_runner.sql', ['ALTER TABLE native_runner_machines ADD COLUMN protocol ', 'CREATE TABLE gitlab_runner_jobs (', 'CREATE INDEX gitlab_runner_jobs_machine ']),
        ]:
            if self.manifest['schema'] < int(number):
                continue
            sql = (ROOT / 'cloudflare/forge/migrations' / filename).read_text()
            digest = hashlib.sha256(sql.encode()).hexdigest()
            if self.state.get('migration' + number) not in (None, digest):
                raise ValueError('Recorded runner migration differs from reviewed source')
            statements = [part.strip() for part in re.sub(r'--[^\n]*', '', sql).split(';') if part.strip()]
            if len(statements) != len(prefixes) or any(not statement.startswith(prefix) for statement, prefix in zip(statements, prefixes)):
                raise ValueError('Runner migration differs from reviewed additions')
            if number == '0019':
                self.command('d1', 'query', self.manifest['database'], '--sql', ';\n'.join(statements) + ';')
            else:
                columns = self.command('d1', 'query', self.manifest['database'], '--sql', 'PRAGMA table_info(native_runner_machines)')[0]['results']
                if 'protocol' not in {row['name'] for row in columns}:
                    self.command('d1', 'query', self.manifest['database'], '--sql', statements[0] + ';')
                for table, statement in [('gitlab_runner_jobs', statements[1]), ('gitlab_runner_jobs_machine', statements[2])]:
                    kind = 'table' if table == 'gitlab_runner_jobs' else 'index'
                    found = self.command('d1', 'query', self.manifest['database'], '--sql', "SELECT name FROM sqlite_master WHERE type='" + kind + "' AND name='" + table + "'")[0]['results']
                    if not found:
                        self.command('d1', 'query', self.manifest['database'], '--sql', statement + ';')
            self.check_runner_schema(int(number))
            if self.state.get('migration' + number) != digest:
                self.state['migration' + number] = digest; self.save(); applied.append(number)

    def retain(self):
        # Persist ownership before effects so a lost PUT acknowledgement is recoverable.
        for asset in self.manifest['assets'].values():
            previous = self.state['assets'].get(asset['key'])
            if previous and previous['sha256'] != asset['sha256']:
                raise ValueError('Retained immutable asset collision')
            data = (self.root / 'releases' / (asset['sha256'] + '.asset')).read_bytes()
            self.state['assets'].setdefault(asset['key'], {**asset, 'state': 'pending', 'etag': hashlib.md5(data, usedforsecurity=False).hexdigest()})
            self.state['assets'][asset['key']]['etag'] = hashlib.md5(data, usedforsecurity=False).hexdigest()
        self.save()

        def upload(asset):
            key = asset['key']
            data = self.command('r2', 'objects', 'get', key, '--bucket-name', self.manifest['bucket'], missing=True, raw=True)
            if data is not None and hashlib.sha256(data).hexdigest() != asset['sha256']:
                raise ValueError('Existing retained asset differs; overwrite refused')
            if data is None:
                self.command('r2', 'objects', 'put', key, '--bucket-name', self.manifest['bucket'], '--content-type', asset['type'], '--file', str(self.root / 'releases' / (asset['sha256'] + '.asset')))
                data = self.command('r2', 'objects', 'get', key, '--bucket-name', self.manifest['bucket'], raw=True)
            if hashlib.sha256(data).hexdigest() != asset['sha256']:
                raise ValueError('Retained asset readback failed')
            with self.lock:
                self.state['assets'][key]['state'] = 'confirmed'
                self.state['assets'][key]['etag'] = hashlib.md5(data, usedforsecurity=False).hexdigest()
                self.save()

        with ThreadPoolExecutor(max_workers=4) as pool:
            for future in as_completed([pool.submit(upload, asset) for asset in self.manifest['assets'].values()]):
                future.result()
        return len(self.manifest['assets'])

    def deploy(self):
        previous = self.check()
        self.retain()
        release = self.manifest['release']
        entry = self.state['releases'].get(release)
        if entry and entry['state'] != 'prepared':
            raise ValueError('This release was already dispatched; inspect its journal and deployment instead of replaying it')
        self.state['releases'][release] = {'state': 'dispatched', 'previousVersion': previous, 'bundleSha256': self.manifest['bundleSha256'], 'schema': self.manifest['schema']}
        self.save()
        if self.settings.get('tests'):
            subprocess.run(['docker', 'tag', self.settings['tests']['image_id'], self.settings['tests']['image']], check=True, capture_output=True, timeout=10)
        process = subprocess.run([shutil.which('cf'), '--profile', self.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=self.root, env=self.env, capture_output=True, timeout=300)
        private_write(self.root / ('release-' + release + '.log'), process.stdout.decode(errors='replace') + process.stderr.decode(errors='replace'))
        match = re.search(rb'Current Version ID:\s*([a-f0-9-]{36})', process.stdout)
        if process.returncode or not match:
            raise RuntimeError('Release response is uncertain; inspect the private journal and provider deployment before retrying')
        version = match[1].decode()
        self.state['releases'][release].update(state='deployed', version=version)
        self.save()
        return version

    def rollback(self):
        entry = self.state['releases'].get(self.manifest['release'], {})
        if entry.get('state') != 'deployed' or self.check() != entry.get('version'):
            raise ValueError('Rollback requires the exact currently deployed release')
        if self.manifest['schema'] >= 16:
            predecessor = next((value for value in self.state['releases'].values() if value.get('version') == entry.get('previousVersion')), {})
            if self.manifest['schema'] >= 18 and predecessor.get('schema', 0) < 18:
                raise ValueError('Rollback would expose private pending reviews; deploy a schema18-compatible fix forward')
            if self.manifest['schema'] >= 19 and predecessor.get('schema', 0) < self.manifest['schema']:
                raise ValueError('Rollback would abandon active runner attempts; deploy a runner-compatible fix forward')
            if predecessor.get('schema', 0) < 16:
                raise ValueError('Rollback would remove native Git rule enforcement; deploy a compatible fix forward')
            previous = self.command('workers', 'versions', 'get', entry['previousVersion'], '--worker-id', self.manifest['worker'], '--include', 'modules')['modules']
            bundle = next(module for module in previous if module['name'] == 'worker.mjs')['content_base64'] if isinstance(previous, list) else previous['worker.mjs']['content_base64']
            if hashlib.sha256(base64.b64decode(bundle, validate=True)).hexdigest() != predecessor.get('bundleSha256'):
                raise ValueError('Rule-compatible rollback bytes could not be verified')
        entry['state'] = 'rollback-dispatched'; self.save()
        result = self.command('workers', 'deployments', 'create', '--worker', self.manifest['worker'], '--strategy', 'percentage', '--versions', json.dumps([{'version_id': entry['previousVersion'], 'percentage': 100}]))
        entry.update(state='rolled-back', rollbackDeployment=result['id']); self.save()
        return result['id']

    def promote(self):
        entry = self.state['releases'].get(self.manifest['release'], {})
        if entry.get('state') != 'rolled-back' or self.check() != entry.get('previousVersion'):
            raise ValueError('Promotion requires the exact recorded rollback predecessor')
        version = entry.get('version', '')
        if not UUID.fullmatch(version):
            raise ValueError('Recorded release version unavailable')
        current = self.command('workers', 'versions', 'get', version, '--worker-id', self.manifest['worker'], '--include', 'modules')
        modules = current['modules']
        bundle = next(module for module in modules if module['name'] == 'worker.mjs')['content_base64'] if isinstance(modules, list) else modules['worker.mjs']['content_base64']
        if hashlib.sha256(base64.b64decode(bundle, validate=True)).hexdigest() != self.manifest['bundleSha256']:
            raise ValueError('Recorded release bytes changed; promotion refused')
        entry['state'] = 'promotion-dispatched'; self.save()
        result = self.command('workers', 'deployments', 'create', '--worker', self.manifest['worker'], '--strategy', 'percentage', '--versions', json.dumps([{'version_id': version, 'percentage': 100}]))
        entry.update(state='deployed', promotionDeployment=result['id']); self.save()
        return result['id']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'migrate', 'retain', 'deploy', 'rollback', 'promote'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--profile', default='golf')
    args = parser.parse_args()
    release = Release(args.directory, args.profile)
    print(json.dumps({'action': args.action, 'result': getattr(release, args.action)()}))


if __name__ == '__main__':
    main()
