import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

from cloudflare_forge import initialize
from cloudflare_setup import ROOT
from cloudflare_hosted_check import deep_history


class NativeSetup(unittest.TestCase):
    def test_owned_deep_history_preserves_tree_and_worktree(self):
        with tempfile.TemporaryDirectory() as temporary:
            def git(*args):
                return subprocess.run(['git', '-C', temporary, *args], check=True,
                                      capture_output=True, timeout=10).stdout.decode().strip()
            git('init', '--initial-branch=main')
            (Path(temporary)/'source.txt').write_text('unchanged source\n')
            git('add', 'source.txt')
            git('-c', 'user.name=Qualification', '-c', 'user.email=test@example.invalid',
                '-c', 'commit.gpgsign=false', 'commit', '-m', 'root')
            parent = git('rev-parse', 'HEAD')
            deep_history(temporary, parent, 1000)
            self.assertEqual(git('rev-list', '--count', 'qualification-long-head'), '1001')
            self.assertEqual(git('rev-list', '--count', 'qualification-long-base..qualification-long-head'), '1')
            self.assertEqual(git('rev-parse', 'qualification-long-head^{tree}'), git('rev-parse', 'HEAD^{tree}'))
            self.assertEqual(git('rev-parse', 'HEAD'), parent)
            self.assertEqual(git('status', '--porcelain'), '')
            for bad_parent, count in [('invalid', 2), (parent, 1), (parent, 1001)]:
                with self.assertRaises(AssertionError):
                    deep_history(temporary, bad_parent, count)

    def test_webhook_policy_validation_precedes_installation_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            policy = {'origins': ['https://receiver.example.com'], 'dailyLimit': 100,
                      'key': {'store': 'b'*32, 'name': 'webhook-key'}}
            invalid = [None, {}, {'dailyLimit': True}, {'dailyLimit': 5001},
                       {'key': {'store': 'b'*32, 'name': '../secret'}}]
            invalid += [{'origins': [origin]} for origin in ['http://receiver.example.com',
                        'https://golf.example.com', 'https://localhost', 'https://127.0.0.1',
                        'https://foo.internal', 'https://receiver.example.com/',
                        'https://receiver.example.com:443', 'https://u:p@receiver.example.com']]
            invalid += [{'origins': policy['origins']*2}, {'origins': [{}]}]
            for change in invalid:
                with self.assertRaises(ValueError):
                    initialize(*args, webhooks={**policy, **change} if change else {})
                self.assertFalse(root.exists())
            initialize(*args, webhooks=policy)
            self.assertEqual(json.loads((root/'forge.json').read_text())['webhooks'], policy)

    def test_anonymous_rate_limit_is_bounded_before_installation_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            limit = {'namespace': '1001', 'limit': 300, 'period': 60}
            for change in [{'namespace': 1001}, {'namespace': '0'}, {'namespace': '2147483648'}, {'namespace': None}, {'limit': 9}, {'limit': 10001},
                           {'limit': True}, {'limit': 300.0}, {'period': 30}, {'period': 60.0}, {'key': 'user'}]:
                with self.assertRaises(ValueError):
                    initialize(*args, anonymous_rate_limit={**limit, **change})
                self.assertFalse(root.exists())
            with self.assertRaises(ValueError):
                initialize(*args, anonymous_rate_limit={'limit': 300})
            initialize(*args, anonymous_rate_limit=limit)
            self.assertEqual(json.loads((root/'forge.json').read_text())['anonymous_rate_limit'], limit)

    def test_execution_value_key_reference_is_dedicated_and_never_a_value(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            key = {'store': 'b'*32, 'name': 'execution-value-key'}
            webhooks = {'origins': ['https://receiver.example.com'], 'dailyLimit': 100, 'key': key}
            for refused in [{}, [], 'key', {'key': None}, {'key': {'store': 'b'*32}}, {'key': {**key, 'store': 'short'}},
                            {'key': {**key, 'name': '../secret'}}, {'key': {**key, 'value': 'fixture'}}, {'key': key, 'value': 'fixture'}]:
                with self.assertRaises(ValueError):
                    initialize(*args, execution_values=refused)
                self.assertFalse(root.exists())
            with self.assertRaisesRegex(ValueError, 'their own encryption key'):
                initialize(*args, webhooks=webhooks, execution_values={'key': key})
            self.assertFalse(root.exists())
            initialize(*args, webhooks={**webhooks, 'key': {**key, 'name': 'webhook-key'}}, execution_values={'key': key})
            self.assertEqual(json.loads((root/'forge.json').read_text())['execution_values'], {'key': key})

    def test_email_policy_is_a_sender_and_a_limit_and_requires_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            policy = {'sender': 'golf@mail.golf.example.com', 'dailyLimit': 200}
            invalid = [None, {}, {'dailyLimit': True}, {'dailyLimit': 0}, {'dailyLimit': 5001}, {'sender': 'Golf@mail.golf.example.com'},
                       {'sender': 'golf'}, {'sender': 'golf@localhost'}, {'sender': 'a@example.com, b@example.com'}, {'sender': ['golf@mail.golf.example.com']},
                       {'token': 'never-a-secret'}, {'key': {'store': 'b'*32, 'name': 'mail'}}]
            for change in invalid:
                with self.assertRaises(ValueError):
                    initialize(*args, access_aud='c'*64, owner_email='owner@example.com', email={**policy, **change} if change else {})
                self.assertFalse(root.exists())
            with self.assertRaisesRegex(ValueError, 'Access'):
                initialize(*args, email=policy)
            self.assertFalse(root.exists())
            initialize(*args, access_aud='c'*64, owner_email='owner@example.com', email=policy)
            self.assertEqual(json.loads((root/'forge.json').read_text())['email'], policy)

    def test_access_team_domain_is_written_only_beside_the_access_audience(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            for team, aud in [('https://team.cloudflareaccess.com', None), ('team.cloudflareaccess.com', 'c'*64),
                              ('https://team.example.com', 'c'*64), ('https://-team.cloudflareaccess.com', 'c'*64)]:
                with self.assertRaises(ValueError):
                    initialize(*args, access_aud=aud, owner_email='owner@example.com', access_team_domain=team)
                self.assertFalse(root.exists())
            initialize(*args, access_aud='c'*64, owner_email='owner@example.com', access_team_domain='https://team.cloudflareaccess.com')
            self.assertEqual(json.loads((root/'forge.json').read_text())['access_team_domain'], 'https://team.cloudflareaccess.com')

    def test_hostname_has_no_owner_default(self):
        result = subprocess.run(['python3', str(ROOT/'scripts/cloudflare_forge.py'), '--account-id', 'a'*32, '--workspace', 'team',
            '--namespace', 'n', '--database-id', 'd', '--database-name', 'n', '--owner', 'owner'], capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--hostname', result.stderr)

    def test_operations_setup_validates_before_writing_and_enrolls_only_the_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            operations = {'service_health': True, 'analytics_secret': {'store': 'b'*32, 'name': 'analytics-read'},
                          'observability': {'enabled': True, 'sampling': .1}}
            for invalid in [{'token': 'never-written'}, {'service_health': 1},
                            {'analytics_secret': {'store': 'b'*32, 'name': '../secret'}},
                            {'observability': {'enabled': True, 'sampling': .11}},
                            {'observability': {'enabled': True, 'sampling': float('nan')}}]:
                with self.assertRaises(ValueError):
                    initialize(*args, operations=invalid)
                self.assertFalse(root.exists())
            initialize(*args, operations=operations)
            self.assertEqual(json.loads((root/'forge.json').read_text())['operations'], operations)
            with sqlite3.connect(':memory:') as db:
                for entry in json.loads((root/'bootstrap.json').read_text()):
                    if entry.get('params'):
                        db.execute(entry['sql'], entry['params'])
                    else:
                        db.executescript(entry['sql'])
                db.execute("INSERT INTO users(id,login,can_create) VALUES(2,'creator',1)")
                self.assertEqual(db.execute('SELECT user_id FROM operations_admins').fetchall(), [(1,)])

    def test_dead_letter_setup_requires_a_distinct_queue(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            evidence = {'bucket': 'golf-evidence', 'queue': 'golf-evidence', 'workflow': 'golf-evidence', 'daily_limit': 2, 'allow_ai': False}
            for queue in ['golf-evidence', '../queue', True]:
                with self.assertRaises(ValueError):
                    initialize(*args, {**evidence, 'dead_letter': queue})
                self.assertFalse(root.exists())
            initialize(*args, {**evidence, 'dead_letter': 'golf-evidence-failures'})
            self.assertEqual(json.loads((root/'forge.json').read_text())['evidence']['dead_letter'], 'golf-evidence-failures')

    def test_native_app_policy_and_migration_are_explicit_and_preserve_existing_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            evidence = {'bucket': 'golf-evidence', 'queue': 'golf-evidence', 'workflow': 'golf-evidence', 'daily_limit': 8, 'allow_ai': False}
            tests = {'module': 'test_calc', 'image': 'golf-cf-agent:qualification', 'image_id': 'sha256:' + 'e'*64}
            previews = {'hostname': 'preview.example.net', 'worker': 'golf-preview', 'access_aud': 'b'*64, 'path': 'public', 'ttl': 900}
            policy = {'namespace': 'golf-apps', 'entry': 'worker.mjs', 'migration': 'schema.sql', 'ttl': 14400, 'zone': 'c'*32, 'gateway': 'golf-preview', 'outbound': 'golf-native-outbound'}
            apps = {'policy': policy, 'provisioner': {'store': 'd'*32, 'name': 'golf-management'}, 'automatic': True}
            for changed in [{**policy, 'entry': '../private.mjs'}, {**policy, 'ttl': True}, {**policy, 'zone': None}, {**policy, 'gateway': 'other-worker'}, {**policy, 'secret': {'store': 'd'*32, 'name': 'golf-management'}}]:
                with self.assertRaises(ValueError):
                    initialize(*args, evidence, tests, access_aud='a'*64, owner_email='owner@example.com', previews=previews, apps={**apps, 'policy': changed}, automatic_ci=True)
                self.assertFalse(root.exists())
            initialize(*args, evidence, tests, access_aud='a'*64, owner_email='owner@example.com', previews=previews, apps=apps, automatic_ci=True)
            settings = json.loads((root/'forge.json').read_text())
            self.assertTrue(settings['automatic_ci'])
            self.assertEqual(settings['apps'], apps)
            self.assertNotIn('token', settings['apps']['provisioner'])
        schema = (ROOT/'cloudflare/forge/schema.sql').read_text().split('-- Native managed application resources')[0]
        schema = '\n'.join(line for line in schema.splitlines() if not line.strip().startswith(('ci_state TEXT', 'kind TEXT NOT NULL DEFAULT')))
        with sqlite3.connect(':memory:') as db:
            db.executescript(schema)
            db.execute("INSERT INTO users(id,login) VALUES(1,'owner')")
            db.executescript((ROOT/'cloudflare/forge/migrations/0004_pr_apps.sql').read_text())
            self.assertEqual(db.execute('SELECT login FROM users').fetchone(), ('owner',))
            self.assertEqual(db.execute('SELECT count(*) FROM ci_intake').fetchone()[0], 0)
            with self.assertRaises(sqlite3.OperationalError):
                db.executescript((ROOT/'cloudflare/forge/migrations/0004_pr_apps.sql').read_text())

    def test_access_native_ui_and_preview_setup_is_explicit_and_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            assets = Path(temporary)/'assets'
            assets.mkdir()
            (assets/'native.html').write_text('<html>Native Golf</html>')
            evidence = {'bucket': 'golf-evidence', 'queue': 'golf-evidence', 'workflow': 'golf-evidence', 'daily_limit': 2, 'allow_ai': False}
            tests = {'module': 'test_calc', 'image': 'golf-cf-agent:qualification', 'image_id': 'sha256:' + 'e'*64}
            preview = {'hostname': 'preview.example.net', 'worker': 'golf-preview', 'access_aud': 'b'*64, 'path': 'public', 'ttl': 900}
            for change in [{'access_aud': 'wrong'}, {'owner_email': None}, {'web_assets': Path(temporary)/'missing'}, {'previews': {**preview, 'hostname': 'golf.example.com'}}, {'previews': {**preview, 'ttl': True}}, {'previews': {**preview, 'path': '../private'}}]:
                settings = {'access_aud': 'a'*64, 'owner_email': 'owner@example.com', 'web_assets': assets, 'previews': preview, **change}
                with self.assertRaises(ValueError):
                    initialize(*args, evidence, tests, **settings)
                self.assertFalse(root.exists())
            initialize(*args, evidence, tests, access_aud='a'*64, owner_email='owner@example.com', web_assets=assets, previews=preview)
            config = json.loads((root/'forge.json').read_text())
            self.assertEqual(config['access_aud'], 'a'*64)
            self.assertEqual(config['previews']['origin'], 'https://preview.example.net')
            self.assertEqual(config['web_assets'], str(assets.resolve()))
            self.assertTrue(config['ui'])
            self.assertEqual(json.loads((root/'bootstrap.json').read_text())[2]['params'], ['owner', 'owner@example.com'])

    def test_existing_native_preview_migration_keeps_private_evidence(self):
        schema = (ROOT/'cloudflare/forge/schema.sql').read_text().split('-- Native protected static PR delivery.')[0]
        with sqlite3.connect(':memory:') as db:
            db.executescript(schema)
            db.execute("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at) VALUES('original',1,1,'key','hash','private-snapshot','NONE','today','today','tomorrow')")
            db.executescript((ROOT/'cloudflare/forge/migrations/0003_pr_previews.sql').read_text())
            self.assertEqual(db.execute('SELECT id,snapshot FROM evidence_jobs').fetchone(), ('original', 'private-snapshot'))
            self.assertEqual(db.execute('SELECT count(*) FROM preview_credentials').fetchone()[0], 0)
            with self.assertRaises(sqlite3.OperationalError):
                db.executescript((ROOT/'cloudflare/forge/migrations/0003_pr_previews.sql').read_text())

    def test_private_independent_bootstrap_and_no_rotation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            initialize(*args)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            for file in root.iterdir():
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            original = (root/'credential.json').read_bytes()
            with self.assertRaises(FileExistsError):
                initialize(*args)
            self.assertEqual(original, (root/'credential.json').read_bytes())
            credential = json.loads(original)
            batch = json.loads((root/'bootstrap.json').read_text())
            self.assertNotIn(credential['token'], json.dumps(batch))
            with sqlite3.connect(':memory:') as db:
                db.executescript(batch[0]['sql'])
                for entry in batch[1:]:
                    db.execute(entry['sql'], entry['params'])
                self.assertEqual(db.execute('SELECT digest FROM credentials').fetchone()[0],
                                 hashlib.sha256(credential['token'].encode()).hexdigest())
            config = json.loads((root/'forge.json').read_text())
            self.assertFalse(config['workers_dev'])
            self.assertEqual(config['origin'], 'https://golf.example.com')

    def test_reject_before_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            with self.assertRaises(ValueError):
                initialize(root, 'a'*32, 'https://bad.example.com', 'golf-native', 'team', 'golf-native',
                           '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            self.assertFalse(root.exists())

    def test_optional_evidence_allocation_is_explicit_and_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            allocation = {'bucket': 'golf-evidence', 'queue': 'golf-evidence', 'workflow': 'golf-evidence', 'daily_limit': 2, 'allow_ai': True, 'gateway': 'golf-evidence'}
            for change in [{'queue': None}, {'daily_limit': True}, {'daily_limit': 21}, {'gateway': None}, {'allow_ai': 'true'}]:
                with self.assertRaises(ValueError):
                    initialize(*args, {**allocation, **change})
                self.assertFalse(root.exists())
            initialize(*args, allocation)
            self.assertEqual(json.loads((root/'forge.json').read_text())['evidence'], allocation)
            self.assertEqual((root/'forge.json').stat().st_mode & 0o777, 0o600)

    def test_container_tests_require_an_explicit_complete_policy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            evidence = {'bucket': 'golf-evidence', 'queue': 'golf-evidence', 'workflow': 'golf-evidence', 'daily_limit': 2, 'allow_ai': False}
            policy = {'module': 'test_calc', 'image': 'golf-cf-agent:qualification', 'image_id': 'sha256:' + 'e'*64}
            for allocation, tests in [(None, policy), (evidence, {**policy, 'module': '-option'}),
                                      (evidence, {**policy, 'module': 'test;curl evil'}), (evidence, {**policy, 'image': None})]:
                with self.assertRaises(ValueError):
                    initialize(*args, allocation, tests)
                self.assertFalse(root.exists())
            initialize(*args, evidence, policy)
            self.assertEqual(json.loads((root/'forge.json').read_text())['tests'], policy)

    def test_native_workflow_setup_requires_one_exact_profile_and_keeps_agents_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            evidence = {'bucket': 'golf-evidence', 'queue': 'golf-evidence', 'workflow': 'golf-evidence', 'daily_limit': 2, 'allow_ai': False}
            base = {'image': 'golf-cf-agent:qualification', 'image_id': 'sha256:' + 'e'*64}
            for workflow in [{'format': 'actions', 'path': '../private.yml'}, {'format': 'gitlab', 'path': 'ci.yml'},
                             {'format': 'actions'}, {'format': 'unknown', 'path': '.gitlab-ci.yml'}]:
                with self.assertRaises(ValueError):
                    initialize(*args, evidence, {**base, 'workflow': workflow})
                self.assertFalse(root.exists())
            for format, path in [('actions', '.github/workflows/pr.yml'), ('gitlab', '.gitlab-ci.yml')]:
                target = root.with_name(format)
                profile = {**base, 'workflow': {'format': format, 'path': path}}
                initialize(target, *args[1:], evidence, profile)
                self.assertEqual(json.loads((target/'forge.json').read_text())['tests'], profile)
            pinned = {**base, 'image': 'alpine:3.23@sha256:' + 'a'*64, 'workflow': {'format': 'gitlab', 'path': '.gitlab-ci.yml'}}
            initialize(root.with_name('pinned-gitlab'), *args[1:], evidence, pinned)
            actions = {**base, 'image': pinned['image'], 'workflow': {'format': 'actions-act', 'path': '.github/workflows/pr.yml'}, 'build': True}
            initialize(root.with_name('pinned-actions'), *args[1:], evidence, actions)
            self.assertEqual(json.loads((root.with_name('pinned-actions')/'forge.json').read_text())['tests'], actions)
            for invalid in [{**actions, 'image': base['image']}, {**actions, 'build': False}, {**base, 'build': True}]:
                with self.assertRaises(ValueError):
                    initialize(root, *args[1:], evidence, invalid)
                self.assertFalse(root.exists())
            with self.assertRaises(ValueError):
                initialize(*args, {**evidence, 'allow_ai': True}, {**base, 'workflow': {'format': 'gitlab', 'path': '.gitlab-ci.yml'}}, agent_path='calc.py')
            self.assertFalse(root.exists())
            # A module beside the hosted Actions shell workflow keeps agent proposals; no other pairing is approved.
            ai = {**evidence, 'allow_ai': True, 'gateway': 'golf-evidence'}
            combined = {**base, 'module': 'test_calc', 'workflow': {'format': 'actions', 'path': '.github/workflows/pr.yml'}}
            for invalid in [{**combined, 'workflow': {'format': 'gitlab', 'path': '.gitlab-ci.yml'}}, {**combined, 'module': '-option'},
                            {**combined, 'image': pinned['image'], 'workflow': {'format': 'actions-act', 'path': '.github/workflows/pr.yml'}}]:
                with self.assertRaises(ValueError):
                    initialize(*args, ai, invalid, agent_path='calc.py')
                self.assertFalse(root.exists())
            with self.assertRaises(ValueError):
                initialize(*args, ai, {**base, 'workflow': combined['workflow']}, agent_path='calc.py')
            self.assertFalse(root.exists())
            initialize(root.with_name('combined'), *args[1:], ai, combined, agent_path='calc.py')
            saved = json.loads((root.with_name('combined')/'forge.json').read_text())
            self.assertEqual((saved['tests'], saved['agent_path']), (combined, 'calc.py'))

    def test_existing_native_evidence_migration_preserves_job_identity(self):
        schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
        before_webhooks = schema.split('-- Native webhook configuration and transactional outbox.')[0]
        old = '\n'.join(line for line in before_webhooks.splitlines() if not line.strip().startswith(('test_state ', 'test_result ')))
        with sqlite3.connect(':memory:') as db:
            db.executescript(old)
            db.execute("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,created_at,updated_at,expires_at) VALUES('original',1,1,'key','original-hash','original-snapshot','NONE','today','today','tomorrow')")
            db.executescript((ROOT/'cloudflare/forge/migrations/0001_pr_tests.sql').read_text())
            self.assertEqual(db.execute('SELECT id,input_hash,snapshot,test_state,test_result FROM evidence_jobs').fetchone(),
                             ('original', 'original-hash', 'original-snapshot', 'NONE', None))

    def test_analytics_is_explicit_and_does_not_provision_or_enable_inference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            evidence = {'bucket': 'golf-evidence', 'queue': 'golf-evidence', 'workflow': 'golf-evidence', 'daily_limit': 2, 'allow_ai': False}
            for allocation, dataset in [(None, 'golf_metrics'), (evidence, 'golf; DROP'), (evidence, 'a'*65)]:
                with self.assertRaises(ValueError):
                    initialize(*args, allocation, None, dataset)
                self.assertFalse(root.exists())
            initialize(*args, evidence, None, 'golf_metrics')
            config = json.loads((root/'forge.json').read_text())
            self.assertEqual(config['analytics_dataset'], 'golf_metrics')
            self.assertFalse(config['evidence']['allow_ai'])

    def test_native_agents_require_source_image_and_private_ai_allocation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'native'
            args = (root, 'a'*32, 'golf.example.com', 'golf-native', 'team', 'golf-native',
                    '12345678-1234-4234-8234-123456789012', 'golf-native', 'owner')
            evidence = {'bucket': 'golf-evidence', 'queue': 'golf-evidence', 'workflow': 'golf-evidence', 'daily_limit': 2, 'allow_ai': True, 'gateway': 'golf-evidence'}
            tests = {'module': 'test_calc', 'image': 'golf-cf-agent:qualification', 'image_id': 'sha256:' + 'e'*64}
            for allocation, image, path in [(None, tests, 'calc.py'), (evidence, None, 'calc.py'),
                    ({**evidence, 'allow_ai': False}, tests, 'calc.py'), (evidence, tests, '../calc.py'),
                    (evidence, tests, '.git/config'), (evidence, tests, 'calc*.py'), (evidence, tests, 'test_calc.py')]:
                with self.assertRaises(ValueError):
                    initialize(*args, allocation, image, None, path)
                self.assertFalse(root.exists())
            initialize(*args, evidence, tests, None, 'calc.py')
            self.assertEqual(json.loads((root/'forge.json').read_text())['agent_path'], 'calc.py')

    def test_native_agent_migration_keeps_existing_job_and_test_result(self):
        schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
        old = '\n'.join(line for line in schema.splitlines() if not line.strip().startswith(('agent_state ', 'agent_fork ', 'agent_publish ', 'agent_result ', 'agent_proposal ')))
        with sqlite3.connect(':memory:') as db:
            db.executescript(old)
            db.execute("INSERT INTO evidence_jobs(id,repository_id,user_id,operation_key,input_hash,snapshot,advice_state,test_state,test_result,created_at,updated_at,expires_at) VALUES('original',1,1,'key','hash','snapshot','NONE','PASSED','saved-test','today','today','tomorrow')")
            db.executescript((ROOT/'cloudflare/forge/migrations/0002_pr_agents.sql').read_text())
            self.assertEqual(db.execute('SELECT id,input_hash,test_result,agent_state,agent_fork,agent_publish,agent_result,agent_proposal FROM evidence_jobs').fetchone(),
                             ('original', 'hash', 'saved-test', 'NONE', None, None, None, None))
