import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cloudflare_alchemy_demo as demo
from cloudflare_setup import replace_private_json


class InstallationBoundary(unittest.TestCase):
    def test_private_installation_must_match_its_directory_and_account(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root/'.tmp/cloudflare-forge/example'
            directory.mkdir(parents=True, mode=0o700)
            config = {'name': 'example', 'account': 'a'*32}
            replace_private_json(directory/'alchemy-input.json', config)
            with patch.object(demo, 'ROOT', root):
                self.assertEqual(demo.load(directory)[1], config)
                directory.chmod(0o755)
                with self.assertRaises(ValueError): demo.load(directory)
                directory.chmod(0o700)
                replace_private_json(directory/'alchemy-input.json', {**config, 'name': 'another-installation'})
                with self.assertRaises(ValueError): demo.load(directory)

    def test_deploy_cannot_adopt_an_occupied_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            replace_private_json(directory/'operator.json', {'value': 'test-only-credential'})
            with patch.object(demo.subprocess, 'run') as run:
                run.return_value.returncode = 0
                demo.run(directory, {'account': 'a'*32, 'name': 'example'}, 'deploy')
                args = run.call_args.args[0]
                self.assertNotIn('--adopt', args)
                self.assertNotIn('test-only-credential', ' '.join(args))
                demo.run(directory, {'account': 'a'*32, 'name': 'example'}, 'plan')
                self.assertIn('--dry-run', run.call_args.args[0])

class SchemaBootstrap(unittest.TestCase):
    def test_redeploy_preserves_data_and_refuses_unreviewed_schema_change(self):
        import os
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            value = {'account': 'a'*32, 'name': 'example', 'email': 'demo@example.com', 'nativeToken': 'test-only'}
            settings = {'account': value['account'], 'worker': value['name'], 'database': {'uuid': 'database'}}
            with patch.dict(os.environ, GOLF_ALCHEMY_SETTINGS=json.dumps(settings)), patch.object(demo, 'cf') as cf, patch.object(demo.subprocess, 'run'):
                cf.return_value = [{'results': []}]
                demo.build(directory, value)
                self.assertEqual(sum('CREATE TABLE' in str(call) for call in cf.call_args_list), 1)
                cf.reset_mock()
                demo.build(directory, value)
                self.assertFalse(any('CREATE TABLE' in str(call) for call in cf.call_args_list))
                receipt = json.loads((directory/'schema-receipt.json').read_text())
                receipt['sha256'] = 'changed'
                replace_private_json(directory/'schema-receipt.json', receipt)
                with self.assertRaisesRegex(ValueError, 'Schema changed'): demo.build(directory, value)


class Observability(unittest.TestCase):
    def test_enabling_observability_preserves_existing_operations_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            value={'settings':{'operations':{'service_health':True,'analytics_secret':{'store':'store','name':'secret'}}}}
            demo.enable_observability(directory,value)
            demo.enable_observability(directory,value)
            saved=json.loads((directory/'alchemy-input.json').read_text())['settings']['operations']
            self.assertEqual(saved,{'service_health':True,'analytics_secret':{'store':'store','name':'secret'},'observability':{'enabled':True,'sampling':0.01}})

    def test_enabling_analytics_names_a_valid_dataset_and_keeps_other_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            value={'name':'golf-alchemy-20261013-0f2087f8','settings':{'evidence':{'daily_limit':40}}}
            demo.enable_analytics(directory,value)
            demo.enable_analytics(directory,value)
            saved=json.loads((directory/'alchemy-input.json').read_text())['settings']
            self.assertEqual(saved,{'evidence':{'daily_limit':40},'analytics_dataset':'golf_alchemy_20261013_0f2087f8'})

    def test_enabling_ai_names_one_gateway_and_agents_only_on_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            value={'name':'golf-alchemy-20261013-0f2087f8','settings':{'evidence':{'daily_limit':40,'allow_ai':False}}}
            demo.enable_ai(directory,value,None)
            saved=json.loads((directory/'alchemy-input.json').read_text())['settings']
            self.assertEqual(saved,{'evidence':{'daily_limit':40,'allow_ai':True,'gateway':'golf-alchemy-20261013-0f2087f8'}})
            demo.enable_ai(directory,value,'calc.py')
            demo.enable_dead_letter(directory,value)
            saved=json.loads((directory/'alchemy-input.json').read_text())['settings']
            self.assertEqual(saved['agent_path'],'calc.py')
            self.assertEqual(saved['evidence']['dead_letter'],'golf-alchemy-20261013-0f2087f8-dead')
            with self.assertRaises(ValueError): demo.enable_ai(directory,{**value,'name':'Bad_Name'},None)

    def test_enabling_webhooks_approves_exact_origins_and_keeps_the_first_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            value={'settings':{'evidence':{'daily_limit':40}}}
            for refused in ([],['http://hooks.example.com'],['https://hooks.example.com/path'],['https://hooks.example.com:8443']):
                with self.assertRaises(ValueError): demo.enable_webhooks(directory,value,refused)
            self.assertFalse((directory/'alchemy-input.json').exists())
            demo.enable_webhooks(directory,value,['https://hooks.example.com'])
            key=json.loads((directory/'alchemy-input.json').read_text())['webhookKey']
            self.assertRegex(key,r'^[A-Za-z0-9+/]{43}=$')
            demo.enable_webhooks(directory,value,['https://other.example.com','https://hooks.example.com'])
            saved=json.loads((directory/'alchemy-input.json').read_text())
            self.assertEqual(saved['webhookKey'],key)
            self.assertEqual(saved['settings'],{'evidence':{'daily_limit':40},'webhooks':{'origins':['https://hooks.example.com','https://other.example.com'],'dailyLimit':500}})


class GuardedMigration(unittest.TestCase):
    table='CREATE TABLE IF NOT EXISTS journal (\n id INTEGER PRIMARY KEY -- one row; per entry\n);\nCREATE UNIQUE INDEX IF NOT EXISTS journal_id ON journal(id);\n'
    trigger="CREATE TRIGGER IF NOT EXISTS journal_seen AFTER INSERT ON journal BEGIN\n INSERT INTO seen(id) VALUES(NEW.id);\n UPDATE seen SET n=CASE WHEN n>0 THEN n ELSE 1 END;\nEND;\n"

    def test_only_repeatable_creates_are_named(self):
        self.assertEqual(demo.migration_objects(self.table+self.trigger),['journal','journal_id','journal_seen'])
        for refused in ('ALTER TABLE journal ADD COLUMN note TEXT;','CREATE TABLE journal (id INTEGER);',self.table+'DROP TABLE users;',
                        self.trigger+'DELETE FROM users;','CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON journal BEGIN\n SELECT 1;\n','-- nothing\n'):
            with self.assertRaises(ValueError): demo.migration_objects(refused)

    def test_pending_migrations_follow_the_reviewed_tail(self):
        import hashlib
        digest=lambda text: hashlib.sha256(text.encode()).hexdigest()
        base='CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);\n'
        files=[('0002_b.sql',self.trigger),('0001_a.sql',self.table)]
        schema=base+'\n'+self.table+'\n'+self.trigger
        self.assertEqual(demo.pending_migrations(schema,digest(schema),files),[])
        self.assertEqual([name for name,_,_ in demo.pending_migrations(schema,digest(base),files)],['0001_a.sql','0002_b.sql'])
        after=demo.pending_migrations(schema,digest(base+'\n'+self.table),files)
        self.assertEqual([(name,digest(result)) for name,_,result in after],[('0002_b.sql',digest(schema))])
        with self.assertRaisesRegex(ValueError,'predecessor'): demo.pending_migrations(schema,digest('other'),files)
        with self.assertRaisesRegex(ValueError,'does not end'): demo.pending_migrations(schema+'\n-- edited',digest(base),files)

    def test_migrate_applies_reads_back_and_advances_the_receipt(self):
        import hashlib
        import sqlite3
        with tempfile.TemporaryDirectory() as temporary, sqlite3.connect(':memory:') as db:
            directory=Path(temporary); db.row_factory=sqlite3.Row
            schema=(demo.ROOT/'cloudflare/forge/schema.sql').read_text()
            migration=(demo.ROOT/'cloudflare/forge/migrations/0022_public_repositories.sql').read_text()
            previous=schema[:-len('\n'+migration)]; db.executescript(previous)
            replace_private_json(directory/'forge.json',{'database':{'uuid':'database'}})
            replace_private_json(directory/'schema-receipt.json',{'database':'database','sha256':hashlib.sha256(previous.encode()).hexdigest()})
            def cf(config,*args):
                if args[:2]==('d1','get'): return {'name':'example','uuid':'database'}
                body=json.loads(args[-1])
                if body['sql'].startswith('SELECT'): return [{'results':[dict(row) for row in db.execute(body['sql'],body['params'])]}]
                db.executescript(body['sql']); return [{'results':[]}]
            with patch.object(demo,'cf',side_effect=cf):
                with self.assertRaisesRegex(ValueError,'ownership'): demo.migrate(directory,{'name':'other'})
                demo.migrate(directory,{'name':'example'})
                demo.migrate(directory,{'name':'example'})
            self.assertEqual(db.execute('SELECT count(*) FROM repository_visibility').fetchone()[0],0)
            self.assertEqual(json.loads((directory/'schema-receipt.json').read_text())['sha256'],hashlib.sha256(schema.encode()).hexdigest())


class PublicMigration(unittest.TestCase):
    def test_public_enable_requires_owned_database_and_reviewed_predecessor(self):
        import hashlib
        import sqlite3
        with tempfile.TemporaryDirectory() as temporary, sqlite3.connect(':memory:') as db:
            directory = Path(temporary)
            db.row_factory = sqlite3.Row
            schema = (demo.ROOT/'cloudflare/forge/schema.sql').read_text()
            migration = (demo.ROOT/'cloudflare/forge/migrations/0022_public_repositories.sql').read_text()
            previous = schema[:-len('\n'+migration)]
            db.executescript(previous)
            value = {'name':'example','settings':{'access_team_domain':'https://example.cloudflareaccess.com'}}
            replace_private_json(directory/'forge.json', {'database':{'uuid':'database'}})
            replace_private_json(directory/'schema-receipt.json', {'database':'database','sha256':'unknown'})
            calls = []
            def cf(config, *args):
                if args[:2] == ('d1','get'): return {'name':'example','uuid':'database'}
                sql = json.loads(args[-1])['sql']; calls.append(sql)
                if sql.startswith('PRAGMA'): return [{'results':[dict(row) for row in db.execute(sql)]}]
                db.executescript(sql); return [{'results':[]}]
            with patch.object(demo,'cf',side_effect=cf):
                with self.assertRaisesRegex(ValueError,'predecessor'): demo.enable_public(directory,value)
                self.assertEqual(calls, [])
                replace_private_json(directory/'schema-receipt.json', {'database':'database','sha256':hashlib.sha256(previous.encode()).hexdigest()})
                demo.enable_public(directory,value)
                demo.enable_public(directory,value)
                self.assertTrue(json.loads((directory/'alchemy-input.json').read_text())['settings']['public_repositories'])
                self.assertEqual(db.execute('SELECT count(*) FROM repository_visibility').fetchone()[0],0)
                self.assertEqual(json.loads((directory/'schema-receipt.json').read_text())['sha256'],hashlib.sha256(schema.encode()).hexdigest())


class RunnerIdentity(unittest.TestCase):
    def test_verification_rejects_provenance_indexes_and_wrong_image_identity(self):
        import hashlib
        import io
        account = 'a'*32
        value = {'account': account, 'name': 'example', 'settings': {'tests': {'image_id': 'sha256:approved'}}}
        credential = {'account_id': account, 'registry_host': 'registry.cloudflare.com', 'username': 'test', 'password': 'test'}
        def check(manifest):
            data = json.dumps(manifest).encode()
            reference = 'registry.cloudflare.com/'+account+'/example@sha256:'+hashlib.sha256(data).hexdigest()
            with patch.object(demo, 'cf', return_value=credential), patch.object(demo.urllib.request, 'urlopen', return_value=io.BytesIO(data)):
                return demo.verify_image(value, reference)
        self.assertEqual(check({'config': {'digest': 'sha256:approved'}})['config'], 'sha256:approved')
        with self.assertRaisesRegex(ValueError, 'single-platform'): check({'manifests': []})
        with self.assertRaisesRegex(ValueError, 'approved local image'): check({'config': {'digest': 'sha256:different'}})


if __name__ == '__main__':
    unittest.main()
