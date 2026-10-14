from cloudflare_setup import ROOT
import sqlite3
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
from cloudflare_rehearsal import await_release
from unittest.mock import patch
from cloudflare_release import Release, load_release
from cloudflare_demo_cleanup import retained_assets
from cloudflare_repository_metadata import parse_tree

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        settings = {'account': 'a'*32, 'worker': 'golf-native-20261009-12345678', 'database': {'uuid': '1'*8+'-'+ '2'*4+'-'+ '3'*4+'-'+ '4'*4+'-'+ '5'*12}, 'namespace': 'native', 'workspace': 'alice', 'origin': 'https://golf.example.com', 'evidence': {'bucket': 'golf-native-20261009-12345678'}}
        (self.root/'forge.json').write_text(json.dumps(settings))
        self.bytes = b'asset bytes'; digest = hashlib.sha256(self.bytes).hexdigest()
        bundle = self.root/'.cloudflare/output/v0/workers/default/bundle/worker.mjs'; bundle.parent.mkdir(parents=True); bundle.write_bytes(b'worker')
        (self.root/'releases').mkdir(); (self.root/'releases'/(digest+'.asset')).write_bytes(self.bytes)
        self.asset = {'key': 'ui-assets/assets/main-12345678.js', 'sha256': digest, 'bytes': len(self.bytes), 'type': 'text/javascript'}
        manifest = {key: settings[key] for key in ['account','worker','namespace','workspace','origin']}
        manifest.update(format=1, schema=14, contract=1, database=settings['database']['uuid'], bucket=settings['evidence']['bucket'], release='c'*64, previousBundleSha256=hashlib.sha256(b'old').hexdigest(), bundleSha256=hashlib.sha256(b'worker').hexdigest(), assets={'/assets/main-12345678.js':self.asset})
        (self.root/'release-manifest.json').write_text(json.dumps(manifest))

    def release(self):
        value = Release(self.root); self.addCleanup(value.guard.close); return value

    def test_identity_and_bytes_are_reviewed(self):
        load_release(self.root)
        (self.root/'releases'/(self.asset['sha256']+'.asset')).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'bytes changed'): load_release(self.root)

    def test_only_transient_asset_reads_retry_and_missing_is_not_retried(self):
        release = self.release()
        failed = subprocess.CompletedProcess([], 1, stdout=b'', stderr=b'503 Service Unavailable')
        success = subprocess.CompletedProcess([], 0, stdout=b'asset bytes', stderr=b'')
        with patch('cloudflare_release.subprocess.run', side_effect=[failed, success]) as run, patch('cloudflare_release.time.sleep'):
            self.assertEqual(release.command('r2', 'objects', 'get', 'owned', raw=True), b'asset bytes')
            self.assertEqual(run.call_count, 2)
        for args, error in [(('r2','objects','put'), failed), (('r2','objects','get'), subprocess.CompletedProcess([], 1, stderr=b'403 Forbidden'))]:
            with patch('cloudflare_release.subprocess.run', return_value=error) as run:
                with self.assertRaises(RuntimeError): release.command(*args)
                self.assertEqual(run.call_count, 1)
        with patch('cloudflare_release.subprocess.run', return_value=subprocess.CompletedProcess([], 1, stderr=b'404 Not Found')) as run:
            self.assertIsNone(release.command('r2','objects','get',missing=True)); self.assertEqual(run.call_count, 1)

    def test_asset_read_timeout_has_a_finite_retry_bound(self):
        release = self.release()
        with patch('cloudflare_release.subprocess.run', side_effect=subprocess.TimeoutExpired('cf', 1)) as run, patch('cloudflare_release.time.sleep'):
            with self.assertRaisesRegex(RuntimeError, 'timed out'): release.command('r2','objects','get')
            self.assertEqual(run.call_count, 3)

    def test_lost_put_ack_resumes_same_key_and_cleanup_ownership(self):
        release = self.release(); objects = {}; lost = True; puts = []
        def command(*args, **kwargs):
            nonlocal lost
            key = args[3]
            if args[2] == 'get': return objects.get(key)
            puts.append(key); objects[key] = self.bytes
            if lost: lost = False; raise RuntimeError('Lost PUT acknowledgement')
            return {}
        release.command = command
        with self.assertRaises(RuntimeError): release.retain()
        pending = json.loads(release.path.read_text()); self.assertEqual(pending['assets'][self.asset['key']]['state'], 'pending')
        self.assertEqual(release.retain(), 1); self.assertEqual(puts, [self.asset['key']])
        assets = retained_assets(self.root, release.manifest['account'], release.manifest['worker']); self.assertEqual(assets[self.asset['key']]['state'], 'confirmed')
        release.state['bucket'] = 'another'; release.save()
        with self.assertRaises(ValueError): retained_assets(self.root, release.manifest['account'], release.manifest['worker'])

    def test_collision_refuses_overwrite(self):
        release = self.release(); calls = []
        def command(*args, **kwargs): calls.append(args[2]); return b'foreign bytes'
        release.command = command
        with self.assertRaisesRegex(ValueError, 'overwrite refused'): release.retain()
        self.assertEqual(calls, ['get'])

    def test_live_predecessor_and_gradual_deployment_are_checked(self):
        release = self.release(); version = '11111111-2222-3333-4444-555555555555'
        percentage = 100
        def command(*args, **kwargs):
            if args[:2] == ('d1','query'):
                with sqlite3.connect(':memory:') as db:
                    db.row_factory = sqlite3.Row
                    db.executescript((ROOT/'cloudflare/forge/schema.sql').read_text())
                    return [{'results': [dict(row) for row in db.execute(args[-1])]}]
            if args[1] == 'deployments': return [{'versions':[{'version_id':version,'percentage':percentage}]}]
            return {'modules':[{'name':'worker.mjs','content_base64':base64.b64encode(b'old').decode()}]}
        release.command = command; self.assertEqual(release.check(), version)
        percentage = 50
        with self.assertRaisesRegex(ValueError, 'gradual'): release.check()
        percentage = 100; release.manifest['previousBundleSha256'] = 'a'*64
        with self.assertRaisesRegex(ValueError, 'predecessor'): release.check()

    def test_operations_migration_resumes_lost_ack_without_role_elevation(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.executescript((ROOT/'cloudflare/forge/schema.sql').read_text())
            db.executescript('DROP TABLE operations_admins; DROP TABLE operations_maintenance; DROP TABLE operations_provider; DROP TABLE operations_delivery_failures;')
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                self.assertFalse(sql.lstrip().startswith('--'), 'CLI SQL must not be parsed as an option')
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql).fetchall()]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost migration acknowledgement')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(RuntimeError, 'Lost migration'): release.migrate()
            self.assertIn('0010', release.migrate())
            self.assertEqual(db.execute('SELECT COUNT(*) FROM operations_admins').fetchone()[0], 0)
            self.assertEqual(release.migrate(), 'already-applied')
            release.state['migration0010'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate()

    def test_access_migration_preserves_grants_and_recovers_missing_triggers(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0011_repository_access.sql').read_text()
            self.assertIn(migration, schema)
            db.executescript(schema[:schema.index(migration)])
            db.executescript("INSERT INTO users(id,login) VALUES(1,'owner'),(2,'reader'); INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'repo','','artifact',1,'key','hash','ACTIVE','2026-10-10'); INSERT INTO grants VALUES(1,1,'admin'),(1,2,'read');")
            before = [tuple(row) for row in db.execute('SELECT * FROM grants ORDER BY user_id')]
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                self.assertFalse(sql.lstrip().startswith('--'), 'CLI SQL must not be parsed as an option')
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if 'grants_insert_revision' in sql and lost:
                    lost = False
                    raise RuntimeError('Lost access migration acknowledgement')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0011'): release.check_access_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost access'): release.migrate()
            self.assertIn('0011', release.migrate())
            self.assertEqual(before, [tuple(row) for row in db.execute('SELECT * FROM grants ORDER BY user_id')])
            db.executescript("UPDATE grants SET role='write' WHERE user_id=2; UPDATE grants SET role='read' WHERE user_id=2; DELETE FROM grants WHERE user_id=2; INSERT INTO grants VALUES(1,2,'read');")
            self.assertEqual(db.execute('SELECT generation FROM collaborator_versions WHERE user_id=2').fetchone()[0], 4)
            db.executescript('DROP TRIGGER grants_delete_revision;')
            with self.assertRaisesRegex(ValueError, 'triggers'): release.check_access_schema()
            self.assertIn('0011', release.migrate())
            self.assertEqual(release.migrate(), 'already-applied')
            release.state['migration0011'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate()

    def test_invitation_migration_preserves_authority_and_resumes_after_lost_ack(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0012_repository_invitations.sql').read_text()
            self.assertIn(migration, schema)
            db.executescript(schema[:schema.index(migration)])
            db.executescript("INSERT INTO users(id,login) VALUES(1,'owner'); INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'repo','','artifact',1,'key','hash','ACTIVE','2026-10-10'); INSERT INTO grants VALUES(1,1,'admin');")
            before = [tuple(row) for row in db.execute('SELECT * FROM grants')]
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                self.assertFalse(sql.lstrip().startswith('--'), 'CLI SQL must not be parsed as an option')
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if 'native_identity_revision' in sql and lost:
                    lost = False
                    raise RuntimeError('Lost invitation migration acknowledgement')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0012'): release.check_invitation_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost invitation'): release.migrate()
            self.assertIn('0012', release.migrate())
            self.assertEqual(before, [tuple(row) for row in db.execute('SELECT * FROM grants')])
            db.executescript("UPDATE users SET active=0; UPDATE users SET active=1;")
            self.assertEqual(db.execute('SELECT version FROM native_identity_versions').fetchone()[0], 2)
            db.executescript('DROP TRIGGER native_identity_revision; DROP INDEX repository_invitation_pending;')
            with self.assertRaisesRegex(ValueError, 'trigger or indexes'): release.check_invitation_schema()
            self.assertIn('0012', release.migrate())
            self.assertEqual(release.migrate(), 'already-applied')
            self.assertEqual(db.execute('SELECT version FROM native_identity_versions').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT count(*) FROM repository_invitations').fetchone()[0], 0)
            release.state['migration0012'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate()

    def test_discussion_migration_preserves_discussions_and_restores_indexes(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0013_discussion_resources.sql').read_text()
            self.assertIn(migration, schema)
            db.executescript(schema[:schema.index(migration)])
            db.executescript("INSERT INTO users(id,login) VALUES(1,'owner'); INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'repo','','artifact',1,'key','hash','ACTIVE','2026-10-10'); INSERT INTO grants VALUES(1,1,'admin'); INSERT INTO discussions VALUES(1,1,1,'issue',1,'existing','body','OPEN',1,'now','now');")
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                self.assertFalse(sql.lstrip().startswith('--'), 'CLI SQL must not be parsed as an option')
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if 'discussion_resource_revision' in sql and lost:
                    lost = False
                    raise RuntimeError('Lost discussion migration acknowledgement')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0013'): release.check_discussion_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost discussion'): release.migrate()
            self.assertIn('0013', release.migrate())
            self.assertEqual(db.execute('SELECT title FROM discussions').fetchone()[0], 'existing')
            db.executescript("INSERT INTO discussion_resources VALUES(1,1,'label','bug','{}',1,0); INSERT INTO discussion_labels VALUES(1,1); DROP TRIGGER discussion_resource_revision; DROP INDEX discussion_resource_name;")
            with self.assertRaisesRegex(ValueError, 'trigger or indexes'): release.check_discussion_schema()
            self.assertIn('0013', release.migrate())
            self.assertEqual(db.execute('SELECT label_id FROM discussion_labels').fetchone()[0], 1)
            db.executescript('UPDATE discussion_resources SET deleted=1 WHERE id=1;')
            self.assertEqual(db.execute('SELECT revision FROM discussions').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT count(*) FROM discussion_labels').fetchone()[0], 0)
            self.assertEqual(release.migrate(), 'already-applied')

    def test_engagement_migration_preserves_activity_and_recovers_lost_ack(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0014_discussion_engagement.sql').read_text()
            db.executescript(schema[:schema.index(migration)])
            db.executescript("INSERT INTO users(id,login) VALUES(1,'owner'); INSERT INTO repositories(id,name,description,artifact_name,creator_id,creation_key,input_hash,state,created_at) VALUES(1,'repo','','artifact',1,'key','hash','ACTIVE','2026-10-10'); INSERT INTO discussions VALUES(1,1,1,'issue',1,'existing','body','OPEN',1,'now','now');")
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                self.assertFalse(sql.lstrip().startswith('--'), 'CLI SQL must not be parsed as an option')
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if 'discussion_reaction_added' in sql and lost:
                    lost = False
                    raise RuntimeError('Lost engagement acknowledgement')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0014'): release.check_engagement_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost engagement'): release.migrate()
            self.assertIn('0014', release.migrate())
            self.assertEqual(db.execute('SELECT title FROM discussions').fetchone()[0], 'existing')
            db.executescript("INSERT INTO discussion_reactions VALUES(1,0,1,'heart'); DROP TRIGGER discussion_reaction_added; DROP INDEX discussion_event_inventory;")
            with self.assertRaisesRegex(ValueError, 'triggers or indexes'): release.check_engagement_schema()
            self.assertIn('0014', release.migrate())
            self.assertEqual(db.execute('SELECT content FROM discussion_reactions').fetchone()[0], 'heart')
            db.executescript('DELETE FROM discussion_reactions;')
            self.assertEqual(db.execute('SELECT version FROM discussion_engagement_versions').fetchone()[0], 2)
            self.assertEqual(release.migrate(), 'already-applied')
            release.state['migration0014'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate()

    def test_webhook_migration_preserves_budget_and_recovers_missing_objects(self):
        release = self.release(); release.manifest['schema'] = 15
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0015_repository_webhooks.sql').read_text()
            db.executescript(schema[:schema.index(migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                self.assertFalse(sql.lstrip().startswith('--'))
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if 'webhook_source_event' in sql and lost:
                    lost = False
                    raise RuntimeError('Lost webhook migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0015'): release.check_webhook_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost webhook'): release.migrate()
            self.assertIn('0015', release.migrate())
            db.executescript("INSERT INTO webhook_daily VALUES('2026-10-10',7); DROP TRIGGER webhook_discussion_event; DROP INDEX webhook_delivery_due;")
            with self.assertRaisesRegex(ValueError, 'triggers or indexes'): release.check_webhook_schema()
            self.assertIn('0015', release.migrate())
            self.assertEqual(db.execute('SELECT attempts FROM webhook_daily').fetchone()[0], 7)
            self.assertEqual(release.migrate(), 'already-applied')
            release.state['migration0015'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate()

    def test_rules_migration_preserves_policy_and_recovers_missing_receipt_table(self):
        release = self.release(); release.manifest['schema'] = 16
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0016_repository_rules.sql').read_text()
            db.executescript(schema[:schema.index(migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if 'repository_rule_operations' in sql and lost:
                    lost = False
                    raise RuntimeError('Lost rules migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0016'): release.check_rules_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost rules'): release.migrate()
            self.assertIn('0016', release.migrate())
            db.executescript("INSERT INTO repository_rules VALUES(1,'owned',7,'[]','[]',2); DROP TABLE repository_rule_operations;")
            with self.assertRaisesRegex(ValueError, '0016'): release.check_rules_schema()
            self.assertIn('0016', release.migrate())
            self.assertEqual(db.execute('SELECT version FROM repository_rules').fetchone()[0], 7)
            db.executescript("INSERT INTO repository_rule_operations VALUES('original',1,1,'digest','receipt','snapshot');")
            self.assertEqual(release.migrate(), 'already-applied')
            self.assertEqual(db.execute('SELECT receipt FROM repository_rule_operations').fetchone()[0], 'receipt')
            release.state['migration0016'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate()

    def test_git_credentials_migration_preserves_hashes_and_recovers_index(self):
        release = self.release(); release.manifest['schema'] = 17
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0017_git_credentials.sql').read_text()
            db.executescript(schema[:schema.index(migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if 'git_credentials_inventory' in sql and lost:
                    lost = False
                    raise RuntimeError('Lost Git credentials migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0017'): release.check_git_credentials_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost Git'): release.migrate()
            self.assertIn('0017', release.migrate())
            db.executescript("INSERT INTO git_credentials VALUES(1,'digest',1,1,'owned','laptop',1,0,1,100,400,NULL); DROP INDEX git_credentials_inventory;")
            with self.assertRaisesRegex(ValueError, 'index'): release.check_git_credentials_schema()
            self.assertIn('0017', release.migrate())
            self.assertEqual(db.execute('SELECT digest FROM git_credentials').fetchone()[0], 'digest')
            self.assertEqual(release.migrate(), 'already-applied')
            release.state['migration0017'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate()

    def test_pull_reviews_migration_recovers_lost_ack_and_preserves_receipts(self):
        release = self.release(); release.manifest['schema'] = 18
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0018_pull_reviews.sql').read_text()
            db.executescript(schema[:schema.index(migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if 'pull_review_operations' in sql and lost:
                    lost = False
                    raise RuntimeError('Lost review migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0018'): release.check_pull_reviews_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost review'): release.migrate()
            self.assertIn('0018', release.migrate())
            db.executescript("INSERT INTO pull_review_operations VALUES(1,'original',1,1,'request','hash','receipt');")
            self.assertEqual(release.migrate(), 'already-applied')
            self.assertEqual(db.execute('SELECT receipt FROM pull_review_operations').fetchone()[0], 'receipt')
            release.state['migration0018'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate()

    def test_runner_migrations_recover_lost_alter_ack(self):
        release = self.release(); release.manifest['schema'] = 20
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            db.executescript(schema[:schema.index('-- Workspace-owned outbound runner identities')])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if sql.startswith('ALTER TABLE native_runner_machines') and lost:
                    lost = False
                    raise RuntimeError('Lost runner migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0019/0020'): release.check_runner_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost runner'): release.migrate_runner_schema([])
            applied = []
            release.migrate_runner_schema(applied)
            self.assertEqual(applied, ['0020'])
            release.check_runner_schema()
            self.assertEqual(release.migrate_runner_schema([]), None)
            release.state['migration0020'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_runner_schema([])

    def test_owner_migration_is_additive_and_recovers_lost_ack(self):
        release = self.release(); release.manifest['schema'] = 21
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            db.executescript(schema[:schema.index('-- Public ownership is separate')])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith('PRAGMA'):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost owner migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError,'0021'): release.check_owner_schema()
            with self.assertRaisesRegex(RuntimeError,'Lost owner'): release.migrate_owner_schema([])
            applied=[]; release.migrate_owner_schema(applied)
            self.assertEqual(applied,['0021']); release.check_owner_schema()
            self.assertEqual(release.migrate_owner_schema([]),None)

    def test_public_migration_resumes_without_publishing_or_replaying(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            db.executescript(schema[:schema.index('CREATE TABLE IF NOT EXISTS repository_visibility')])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith('PRAGMA'):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost public migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0022'): release.check_public_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost public'): release.migrate_public_schema([])
            applied = []; release.migrate_public_schema(applied)
            self.assertEqual(applied, ['0022'])
            self.assertEqual(db.execute('SELECT count(*) FROM repository_visibility').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM public_profiles').fetchone()[0], 0)
            applied = []; release.migrate_public_schema(applied)
            self.assertEqual(applied, [])
            release.state['migration0022'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_public_schema([])

    def test_email_migration_preserves_consent_and_recovers_missing_objects(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0027_email_notifications.sql').read_text()
            self.assertIn(';\n\n' + migration, schema)
            db.executescript(schema[:schema.index(migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                self.assertNotIn('--', sql)
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost email migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0027'): release.check_email_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost email'): release.migrate_email_schema([])
            applied = []; release.migrate_email_schema(applied)
            self.assertEqual(applied, ['0027']); release.check_email_schema()
            db.executescript("INSERT INTO users(id,login,email) VALUES(1,'owner','owner@example.com'); INSERT INTO email_preferences VALUES(1,3,1,'owner@example.com',0,'','2026'); INSERT INTO email_daily VALUES('2026-10-14',7);"
                             "DROP TRIGGER email_source_event; DROP INDEX email_delivery_due;")
            with self.assertRaisesRegex(ValueError, 'triggers or indexes'): release.check_email_schema()
            applied = []; release.migrate_email_schema(applied)
            self.assertEqual(applied, ['0027'])
            self.assertEqual(tuple(db.execute('SELECT version,enabled,email FROM email_preferences').fetchone()), (3, 1, 'owner@example.com'))
            self.assertEqual(db.execute('SELECT attempts FROM email_daily').fetchone()[0], 7)
            applied = []; release.migrate_email_schema(applied)
            self.assertEqual(applied, [])
            release.state['migration0027'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_email_schema([])

    def test_environment_migration_resumes_without_replaying(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            db.executescript(schema[:schema.index('CREATE TABLE IF NOT EXISTS repository_environments')])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith('PRAGMA'):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost environment migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0023'): release.check_environment_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost environment'): release.migrate_environment_schema([])
            applied = []; release.migrate_environment_schema(applied)
            self.assertEqual(applied, ['0023']); release.check_environment_schema()
            self.assertEqual(db.execute('SELECT count(*) FROM repository_environments').fetchone()[0], 0)
            applied = []; release.migrate_environment_schema(applied)
            self.assertEqual(applied, [])
            self.assertEqual(db.execute("SELECT sql FROM sqlite_master WHERE name='repository_environments_live'").fetchone()[0].split(' WHERE ')[1], 'deleted=0')
            release.state['migration0023'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_environment_schema([])

    def test_pull_merge_migration_resumes_and_requires_its_uniqueness_indexes(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0024_pull_merges.sql').read_text()
            self.assertIn(';\n\n'+migration, schema)
            db.executescript(schema[:schema.index('\n'+migration)])
            lost = True; writes = []
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith(('PRAGMA', 'SELECT')):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                writes.append(sql); db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost pull merge migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0024'): release.check_pull_merge_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost pull merge'): release.migrate_pull_merge_schema([])
            applied = []; release.migrate_pull_merge_schema(applied)
            self.assertEqual(applied, ['0024']); release.check_pull_merge_schema()
            self.assertEqual(db.execute('SELECT count(*) FROM pull_merge_operations').fetchone()[0], 0)
            applied = []; release.migrate_pull_merge_schema(applied)
            self.assertEqual(applied, []); self.assertEqual(len(writes), 2)
            # A table without either partial unique index would admit two unresolved merges or two successes.
            for index in ['pull_merge_one_unresolved', 'pull_merge_one_success']:
                db.execute('DROP INDEX '+index)
                with self.assertRaisesRegex(ValueError, 'uniqueness'): release.check_pull_merge_schema()
                db.execute('CREATE INDEX '+index+' ON pull_merge_operations(pull_request_id)')
                with self.assertRaisesRegex(ValueError, 'uniqueness'): release.check_pull_merge_schema()
                db.execute('DROP INDEX '+index)
                applied = []; release.migrate_pull_merge_schema(applied)
                self.assertEqual(applied, ['0024']); release.check_pull_merge_schema()
            release.state['migration0024'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_pull_merge_schema([])

    def test_execution_policy_migration_follows_its_predecessor_resumes_and_leaves_repositories_enabled(self):
        release = self.release()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0025_repository_execution_policy.sql').read_text()
            self.assertIn(';\n\n'+migration, schema)
            db.executescript(schema[:schema.index('\n'+migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith('PRAGMA'):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost execution policy migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0025'): release.check_execution_policy_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost execution'): release.migrate_execution_policy_schema([])
            applied = []; release.migrate_execution_policy_schema(applied)
            self.assertEqual(applied, ['0025'])
            # No row is written: every existing repository stays enabled within the operator allocation.
            self.assertEqual(db.execute('SELECT count(*) FROM repository_execution_policy').fetchone()[0], 0)
            applied = []; release.migrate_execution_policy_schema(applied)
            self.assertEqual(applied, [])
            release.state['migration0025'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_execution_policy_schema([])

    def test_pull_merge_schema_gates_only_schema24_releases(self):
        release = self.release(); called = []
        for name in ['check_access_schema', 'check_invitation_schema', 'check_discussion_schema', 'check_engagement_schema', 'check_webhook_schema', 'check_rules_schema',
                     'check_git_credentials_schema', 'check_pull_reviews_schema', 'check_runner_schema', 'check_owner_schema', 'check_public_schema', 'check_environment_schema']:
            setattr(release, name, lambda *args: None)
        release.check_pull_merge_schema = lambda: called.append('check')
        release.migrate_pull_merge_schema = lambda applied: called.append('migrate')
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.executescript((ROOT/'cloudflare/forge/schema.sql').read_text())
            def command(*args, **kwargs):
                if args[0] != 'd1': raise RuntimeError('stop before provider deployment reads')
                return [{'results': [dict(row) for row in db.execute(args[-1])]}]
            release.command = command
            for schema, expected in [(23, []), (24, ['check'])]:
                release.manifest['schema'] = schema; called.clear()
                with self.assertRaisesRegex(RuntimeError, 'stop before provider'): release.check()
                self.assertEqual(called, expected)
        for name in ['migrate_access', 'migrate_invitations', 'migrate_discussions', 'migrate_engagement', 'migrate_webhooks', 'migrate_rules', 'migrate_git_credentials',
                     'migrate_pull_reviews', 'migrate_runner_schema', 'migrate_owner_schema', 'migrate_public_schema', 'migrate_environment_schema']:
            setattr(release, name, lambda applied: None)
        release.state['migration0010'] = hashlib.sha256((ROOT/'cloudflare/forge/migrations/0010_operations.sql').read_text().encode()).hexdigest()
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.executescript((ROOT/'cloudflare/forge/schema.sql').read_text())
            release.command = lambda *args, **kwargs: [{'results': [dict(row) for row in db.execute(args[-1])]}]
            for schema, expected in [(23, []), (24, ['migrate'])]:
                release.manifest['schema'] = schema; called.clear(); release.migrate()
                self.assertEqual(called, expected)


    def test_uncertain_deployment_is_not_dispatched_twice(self):
        release = self.release(); release.check = lambda: 'previous'; release.retain = lambda: 1
        release.state['releases'][release.manifest['release']] = {'state':'dispatched'}
        with patch('cloudflare_release.subprocess.run') as run:
            with self.assertRaisesRegex(ValueError, 'already dispatched'): release.deploy()
            run.assert_not_called()

    def test_rollback_and_promotion_fence_lost_acknowledgements(self):
        release = self.release()
        entry = {'state': 'deployed', 'version': '11111111-2222-3333-4444-555555555555', 'previousVersion': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}
        release.state['releases'][release.manifest['release']] = entry
        release.check = lambda: entry['version']
        def lost(*args, **kwargs):
            raise RuntimeError('Lost deployment acknowledgement')
        release.command = lost
        with self.assertRaises(RuntimeError): release.rollback()
        self.assertEqual(entry['state'], 'rollback-dispatched')
        with self.assertRaises(ValueError): release.rollback()
        entry['state'] = 'rolled-back'; release.check = lambda: entry['previousVersion']
        def promotion(*args, **kwargs):
            if args[1] == 'versions':
                return {'modules': [{'name': 'worker.mjs', 'content_base64': base64.b64encode(b'worker').decode()}]}
            return lost()
        release.command = promotion
        with self.assertRaises(RuntimeError): release.promote()
        self.assertEqual(entry['state'], 'promotion-dispatched')
        with self.assertRaises(ValueError): release.promote()

    def test_review_release_cannot_rollback_to_code_without_draft_privacy(self):
        release = self.release(); release.manifest['schema'] = 18
        release.state['releases'][release.manifest['release']] = {'state':'deployed','version':'current','previousVersion':'previous'}
        release.state['releases']['old'] = {'version':'previous','schema':17}
        release.check = lambda: 'current'
        release.command = lambda *args, **kwargs: self.fail('Unsafe rollback must not call provider')
        with self.assertRaisesRegex(ValueError, 'private pending reviews'): release.rollback()

    def test_rules_release_cannot_rollback_to_code_without_enforcement(self):
        release = self.release(); release.manifest['schema'] = 16
        entry = {'state': 'deployed', 'version': 'current', 'previousVersion': 'previous'}
        release.state['releases'][release.manifest['release']] = entry
        release.check = lambda: entry['version']; calls = []
        def command(*args, **kwargs):
            calls.append(args)
            if args[1] == 'versions':
                return {'modules': [{'name': 'worker.mjs', 'content_base64': base64.b64encode(b'previous code').decode()}]}
            return {'id': 'rollback'}
        release.command = command
        for schema in (None, 15):
            if schema: release.state['releases']['old'] = {'version': 'previous', 'schema': schema}
            with self.assertRaisesRegex(ValueError, 'remove native Git rule enforcement'): release.rollback()
            self.assertEqual(calls, []); self.assertEqual(entry['state'], 'deployed')
        predecessor = {'version': 'previous', 'schema': 16, 'bundleSha256': 'unverified'}
        release.state['releases']['old'] = predecessor
        with self.assertRaisesRegex(ValueError, 'rollback bytes'): release.rollback()
        self.assertEqual(entry['state'], 'deployed')
        predecessor['bundleSha256'] = hashlib.sha256(b'previous code').hexdigest()
        self.assertEqual(release.rollback(), 'rollback')
        self.assertEqual(entry['state'], 'rolled-back')

    def test_promotion_reuses_only_the_reviewed_version(self):
        release = self.release()
        entry = {'state': 'rolled-back', 'version': '11111111-2222-3333-4444-555555555555', 'previousVersion': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}
        release.state['releases'][release.manifest['release']] = entry
        release.check = lambda: entry['previousVersion']; calls = []
        content = b'foreign'
        def command(*args, **kwargs):
            calls.append(args)
            if args[1] == 'versions':
                return {'modules': [{'name': 'worker.mjs', 'content_base64': base64.b64encode(content).decode()}]}
            return {'id': 'deployment'}
        release.command = command
        with self.assertRaisesRegex(ValueError, 'bytes changed'): release.promote()
        self.assertEqual(len(calls), 1)
        content = b'worker'; self.assertEqual(release.promote(), 'deployment')
        self.assertEqual(entry['state'], 'deployed')
        self.assertIn(entry['version'], calls[-1][-1])

    def test_served_release_requires_schema_and_a_bounded_wait(self):
        with self.assertRaisesRegex(RuntimeError, 'deadline'):
            await_release(lambda path: {'release': 'current', 'schema': 9}, 'current', timeout=0)
        self.assertEqual(await_release(lambda path: {'release': 'current', 'schema': 18}, 'current', timeout=0)['schema'], 18)
        self.assertEqual(await_release(lambda path: {'release': 'previous', 'schema': 10}, 'previous', timeout=0, schema=10)['schema'], 10)

    def test_canonical_inventory_preserves_sizes_and_rejects_unsafe_names(self):
        data = b'100644 blob ' + b'a'*40 + b' 17\tapp.ts\0'
        self.assertEqual(parse_tree(data, True)[0]['size'], 17)
        with self.assertRaises(ValueError): parse_tree(data.replace(b'app.ts',b'../secret.ts'), True)
        with self.assertRaises(ValueError): parse_tree(data.replace(b'17',b'999999999'), True)



class RehearsalAssetsTest(unittest.TestCase):
    def test_release_readiness_rejects_split_worker_and_workspace_versions(self):
        from cloudflare_rehearsal import require_converged_diagnostics
        with self.assertRaises(RuntimeError): require_converged_diagnostics({'release':'old','schema':18}, 'new')
        with self.assertRaises(RuntimeError): require_converged_diagnostics({'release':'new','schema':18}, None)
        self.assertEqual(require_converged_diagnostics({'release':'new','schema':18}, 'new')['schema'], 18)
        with self.assertRaises(RuntimeError): require_converged_diagnostics({'release':'new','configuration':'old'}, 'new', 'new')
        self.assertEqual(require_converged_diagnostics({'release':'new','configuration':'same'}, 'new', 'same')['configuration'], 'same')

    def test_baseline_preserves_asset_inventory_and_original_frontend(self):
        from cloudflare_rehearsal import baseline_assets
        with tempfile.TemporaryDirectory() as root:
            source, destination = Path(root)/'original', Path(root)/'baseline'
            source.mkdir()
            (source/'native.html').write_text('<html>Golf</html>')
            (source/'theme.js').write_text('/* theme */')
            baseline_assets(source, destination)
            self.assertEqual({p.name for p in source.iterdir()}, {p.name for p in destination.iterdir()})
            self.assertEqual((source/'native.html').read_text(), '<html>Golf</html>')
            self.assertTrue((destination/'native.html').read_text().startswith('<html>Golf</html>'))
            self.assertIn('rollback baseline', (destination/'native.html').read_text())
            self.assertEqual((source/'theme.js').read_bytes(), (destination/'theme.js').read_bytes())


class ExecutionValueMigrationTest(unittest.TestCase):
    setUp = ReleaseTests.setUp
    release = ReleaseTests.release

    def test_execution_value_migration_follows_its_predecessor_resumes_and_adds_only_reviewed_objects(self):
        release = self.release(); release.manifest['schema'] = 26
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0026_execution_values.sql').read_text()
            self.assertIn(';\n\n'+migration, schema)
            db.executescript(schema[:schema.index('\n'+migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith('PRAGMA'):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost execution value migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0026'): release.check_execution_value_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost execution value'): release.migrate_execution_value_schema([])
            applied = []; release.migrate_execution_value_schema(applied)
            self.assertEqual(applied, ['0026'])
            self.assertEqual(db.execute('SELECT count(*) FROM execution_values').fetchone()[0], 0)
            applied = []; release.migrate_execution_value_schema(applied)
            self.assertEqual(applied, [])
            release.state['migration0026'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_execution_value_schema([])

    def test_release_migration_follows_its_predecessor_and_resumes_without_replaying(self):
        release = self.release(); release.manifest['schema'] = 28
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0028_releases.sql').read_text()
            self.assertIn(';\n\n'+migration, schema)
            db.executescript(schema[:schema.index('\n'+migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith('PRAGMA'):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost release migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0028'): release.check_release_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost release'): release.migrate_release_schema([])
            applied = []; release.migrate_release_schema(applied)
            self.assertEqual(applied, ['0028']); release.check_release_schema()
            self.assertEqual(db.execute('SELECT count(*) FROM repository_releases').fetchone()[0], 0)
            applied = []; release.migrate_release_schema(applied)
            self.assertEqual(applied, [])
            self.assertEqual(db.execute("SELECT sql FROM sqlite_master WHERE name='repository_release_assets_name'").fetchone()[0].split(' WHERE ')[1], 'deleted=0')
            release.state['migration0028'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_release_schema([])

    def test_attachment_migration_is_the_schema_tail_resumes_without_replaying(self):
        release = self.release(); release.manifest['schema'] = 29
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            schema = (ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (ROOT/'cloudflare/forge/migrations/0029_discussion_attachments.sql').read_text()
            self.assertTrue(schema.endswith(';\n\n'+migration))
            db.executescript(schema[:-len('\n'+migration)])
            lost = True
            def command(*args, **kwargs):
                nonlocal lost
                sql = args[-1]
                if sql.startswith('PRAGMA'):
                    return [{'results': [dict(row) for row in db.execute(sql)]}]
                db.executescript(sql)
                if lost:
                    lost = False
                    raise RuntimeError('Lost attachment migration response')
                return [{'results': []}]
            release.command = command
            with self.assertRaisesRegex(ValueError, '0029'): release.check_attachment_schema()
            with self.assertRaisesRegex(RuntimeError, 'Lost attachment'): release.migrate_attachment_schema([])
            applied = []; release.migrate_attachment_schema(applied)
            self.assertEqual(applied, ['0029']); release.check_attachment_schema()
            self.assertEqual(db.execute('SELECT count(*) FROM discussion_attachments').fetchone()[0], 0)
            applied = []; release.migrate_attachment_schema(applied)
            self.assertEqual(applied, [])
            release.state['migration0029'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'differs'): release.migrate_attachment_schema([])

if __name__ == '__main__': unittest.main()
