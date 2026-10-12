import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import datetime as dt

import cloudflare_demo
import cloudflare_demo_cleanup
from cloudflare_demo import control, process_matches
from cloudflare_demo_cleanup import same, index_inventory, retire_owned
from cloudflare_setup import replace_private_json


class DemoSupervisorTest(unittest.TestCase):
    def test_orphaned_app_cleanup_uses_original_identity_and_revokes_credential(self):
        state = {'demo': {'url': 'https://demo.example', 'previews': [{'id': 'app', 'kind': 'WORKER'}]},
                 'resources': {'preview_service_token': {'id': 'service', 'name': 'owned'}}}
        settings = {'origin': 'https://demo.example', 'workspace': 'alice'}
        pending = [{'id': 'app', 'kind': 'WORKER', 'purged': 0}]
        calls = []
        def cf(*args):
            calls.append(args)
            return {'id': 'service', 'name': 'owned', 'client_id': 'client', 'client_secret': 'secret'}
        def query(sql, params):
            calls.append((sql, params))
            return [{'id': 'app', 'repository_id': 7, 'name': 'canonical', 'creator_id': 1}]
        def post(url, payload, headers):
            self.assertEqual(url, 'https://demo.example/native/pr-preview')
            self.assertEqual(payload, {'action': 'revoke', 'previewId': 'app', 'repository': {'owner': 'alice', 'name': 'canonical'}, 'repositoryId': '7'})
            self.assertEqual(headers['Origin'], settings['origin'])
            self.assertEqual(headers['CF-Access-Client-Secret'], 'secret')
            return {'preview': {'id': 'app', 'purged': True}}
        cloudflare_demo_cleanup.retire_demo_apps(state, settings, pending, cf, query, post)
        self.assertTrue(calls[-1][0].startswith('UPDATE credentials SET revoked=1'))
        for response in [{'preview': {'id': 'foreign', 'purged': True}}, {'preview': {'id': 'app', 'purged': False}}]:
            with self.assertRaisesRegex(RuntimeError, 'not confirmed'):
                cloudflare_demo_cleanup.retire_demo_apps(state, settings, pending, cf, query, lambda *args: response)
            self.assertTrue(calls[-1][0].startswith('UPDATE credentials SET revoked=1'))
        before = len(calls)
        with self.assertRaises(ValueError):
            cloudflare_demo_cleanup.retire_demo_apps(state, settings, [{'id': 'foreign', 'kind': 'WORKER'}], cf, query, post)
        self.assertEqual(len(calls), before)
        cloudflare_demo_cleanup.retire_demo_apps(state, settings, [], cf, query, post)
        self.assertEqual(len(calls), before)

    def test_worker_retirement_respects_service_binding_dependencies(self):
        resources = {key: {'id': key, 'name': key} for key in ['preview_worker', 'worker', 'app_outbound']}
        remaining = set(resources); events = []
        def retire(key, read, delete, original, fields):
            if key == 'worker': self.assertNotIn('preview_worker', remaining)
            if key == 'app_outbound': self.assertNotIn('worker', remaining)
            self.assertEqual(delete[2], original['id'])
            self.assertEqual(fields, ['id', 'name'])
            remaining.remove(key); events.append(key)
        cloudflare_demo_cleanup.retire_workers(resources, retire, lambda: events.append('detach'))
        self.assertEqual(events, ['preview_worker', 'detach', 'worker', 'app_outbound'])
        self.assertEqual(remaining, set())

    def test_failed_control_retirement_preserves_outbound_authority(self):
        resources = {key: {'id': key, 'name': key} for key in ['preview_worker', 'worker', 'app_outbound']}
        events = []
        def retire(key, *args):
            events.append(key)
            if key == 'worker': raise RuntimeError('Delete pending')
        with self.assertRaisesRegex(RuntimeError, 'pending'):
            cloudflare_demo_cleanup.retire_workers(resources, retire, lambda: None)
        self.assertEqual(events, ['preview_worker', 'worker'])

    def test_demo_activation_renews_original_previews_without_revocation_or_allocation(self):
        rows=[{'id':kind,'kind':kind,'state':'READY','purged':False,'expiresAt':'original','commitId':'same','sha256':'same'} for kind in ['STATIC','WORKER']]
        calls=[]
        def observe(path, body):
            calls.append(body)
            if body['action']=='list':return {'previews':rows}
            row=next(row for row in rows if row['id']==body['previewId'])
            self.assertEqual(body['action'],'renew');self.assertEqual(body['expectedExpiresAt'],'original')
            return {'preview':{**row,'expiresAt':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=4)).isoformat()}}
        renewed=cloudflare_demo.renew_previews(observe,{'repositoryId':'1'})
        self.assertEqual([row['id'] for row in renewed],['STATIC','WORKER'])
        self.assertEqual([body['action'] for body in calls],['list','renew','renew'])
        incomplete_calls=[]
        def incomplete(path,body):
            incomplete_calls.append(body['action'])
            return {'previews':rows[:1]}
        with self.assertRaises(RuntimeError):cloudflare_demo.renew_previews(incomplete,{})
        self.assertEqual(incomplete_calls,['list'])
        for change in [{'id':'replacement'},{'sha256':'changed'},{'state':'PUBLISHING'},{'purged':True},{'expiresAt':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5)).isoformat()}]:
            def invalid(path,body):return {'previews':rows} if body['action']=='list' else {'preview':{**rows[0],'expiresAt':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=4)).isoformat(),**change}}
            with self.assertRaises(RuntimeError):cloudflare_demo.renew_previews(invalid,{})

    def test_recovery_retains_only_original_pending_token_ids_and_rejects_other_names(self):
        name='golf-native-20261009-12345678'; token={'id':'a'*32,'name':name+'-recovery','state':'created'}
        self.assertEqual(cloudflare_demo_cleanup.recovery_tokens({'recovery_token':{**token,'state':'absent'}},name), [])
        self.assertEqual(cloudflare_demo_cleanup.recovery_tokens({'pending_recovery_tokens':[token],'recovery_token':token},name), [{'id':token['id'],'name':token['name']}])
        for change in [{'id':'../other'}, {'name':'unrelated-token'}]:
            with self.assertRaises(ValueError): cloudflare_demo_cleanup.recovery_tokens({'recovery_token':{**token,**change}},name)
        with self.assertRaises(ValueError): cloudflare_demo_cleanup.recovery_tokens({'pending_recovery_tokens':[token]*21},name)

    def test_interrupted_journal_replacement_preserves_previous_private_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'ownership.json'
            replace_private_json(path, {'state':'before'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with patch('cloudflare_setup.os.replace', side_effect=OSError('Interrupted publication')):
                with self.assertRaises(OSError): replace_private_json(path, {'state':'after'})
            self.assertEqual(json.loads(path.read_text()), {'state':'before'})
            self.assertEqual(list(path.parent.iterdir()), [path])
            replace_private_json(path, {'state':'after'})
            self.assertEqual(json.loads(path.read_text()), {'state':'after'})

    def test_missing_provider_result_accepts_wrapped_cli_status_without_other_failures(self):
        for response in [b'404 Not Found', b'404\nNot Found', b'404\n  Not\nFound', '│ Failed to retrieve info: 404\n│ Not Found\n└'.encode()]:
            self.assertTrue(cloudflare_demo_cleanup.missing_response(response))
        for response in [b'403 Forbidden', b'404 unrelated operation', b'Not Found', b'150404 Not Found']:
            self.assertFalse(cloudflare_demo_cleanup.missing_response(response))

    def test_static_storage_can_be_retired_after_writers_but_worker_apps_must_be_purged(self):
        cloudflare_demo_cleanup.require_purged_apps([{'kind': 'STATIC', 'purged': 0}, {'kind': 'WORKER', 'purged': 1}])
        for rows in [[{'kind': 'WORKER', 'purged': 0}], [{'purged': 1}], [{'kind': 'unexpected', 'purged': 1}]]:
            with self.assertRaises(ValueError): cloudflare_demo_cleanup.require_purged_apps(rows)

    def test_cleanup_index_inventory_requires_exact_keys_hashes_and_bounded_sizes(self):
        row = {'key': 'repository-indexes/v1/' + 'a'*64 + '/' + 'b'*40 + '/' + 'c'*64 + '.json', 'payload_hash': 'd'*64, 'payload_bytes': 0}
        self.assertEqual(index_inventory([row])[row['key']], {'sha256': 'd'*64, 'bytes': 0})
        for change in [{'key': '../private'}, {'payload_hash': 'unknown'}, {'payload_bytes': True}, {'payload_bytes': -1}, {'payload_bytes': 262145}]:
            with self.assertRaises(ValueError): index_inventory([{**row, **change}])
        with self.assertRaises(ValueError): index_inventory([row]*257)

    def test_begin_requires_private_owned_receipt_and_runs_once(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(cloudflare_demo, 'ROOT', Path(tmp)), patch.object(cloudflare_demo, 'process_matches', return_value=True), patch.object(cloudflare_demo, 'arm_deadline') as timer:
            directory = Path(tmp) / '.tmp/cloudflare-forge/run'
            directory.mkdir(parents=True)
            receipt = directory / 'ownership.json'
            receipt.write_text(json.dumps({'state': 'awaiting_login', 'demo': {'url': 'https://demo.example'}, 'demo_process': {'pid': 123}}))
            receipt.chmod(0o644)
            with self.assertRaises(ValueError):
                control('begin', receipt)
            receipt.chmod(0o600)
            self.assertIn('requested', control('begin', receipt))
            timer.assert_called_once_with(receipt.resolve(), 14700)
            self.assertEqual((directory / 'demo.begin').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                control('begin', receipt)
            timer.assert_called_once()

    def test_timer_failure_withholds_demo_begin(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(cloudflare_demo, 'ROOT', Path(tmp)), patch.object(cloudflare_demo, 'process_matches', return_value=True), patch.object(cloudflare_demo, 'arm_deadline', side_effect=RuntimeError('Timer unavailable')):
            directory = Path(tmp)/'.tmp/cloudflare-forge/run'; directory.mkdir(parents=True)
            receipt = directory/'ownership.json'; receipt.write_text(json.dumps({'state':'awaiting_login','demo':{'url':'https://demo.example'}})); receipt.chmod(0o600)
            with self.assertRaises(RuntimeError): control('begin', receipt)
            self.assertFalse((directory/'demo.begin').exists())
            alias = directory / 'alias'
            alias.symlink_to(receipt)
            with self.assertRaises(ValueError):
                control('begin', alias)

    def test_timer_is_bounded_preserves_cli_path_and_requires_readback(self):
        receipt = Path('/private/ownership.json')
        replies = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, stdout=b'active\n')]
        with patch.object(cloudflare_demo, 'load_receipt', return_value=(receipt, {'state': 'awaiting_login'})), patch.object(cloudflare_demo.subprocess, 'run', side_effect=replies) as run:
            unit = cloudflare_demo.arm_deadline(receipt, 1800)
            timer_command = run.call_args_list[1].args[0]
            self.assertIn('--timer-property=AccuracySec=1s', timer_command)
            for property in ['Restart=on-failure', 'RestartSec=30', 'StartLimitBurst=3', 'StartLimitIntervalSec=7200']:
                self.assertIn('--property=' + property, timer_command)
            self.assertTrue(unit.startswith('golf-demo-stop-'))
            args = run.call_args_list[1].args[0]
            self.assertIn('--on-active=1800s', args)
            self.assertTrue(any(arg.startswith('--setenv=PATH=') for arg in args))
            self.assertEqual(run.call_args_list[2].args[0][-1], unit + '.timer')
        with patch.object(cloudflare_demo, 'load_receipt', return_value=(receipt, {'state': 'awaiting_login'})), patch.object(cloudflare_demo.subprocess, 'run') as run:
            for seconds in [True, 0, 14701]:
                with self.assertRaises(ValueError): cloudflare_demo.arm_deadline(receipt, seconds)
            run.assert_not_called()

    def test_only_explicit_unattended_run_can_arm_before_readiness(self):
        receipt = Path('/private/ownership.json')
        replies = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, stdout=b'active\n')]
        for unattended in [False, True]:
            state = {'state': 'running', 'demo': {'unattended': unattended}}
            with patch.object(cloudflare_demo, 'load_receipt', return_value=(receipt, state)), patch.object(cloudflare_demo.subprocess, 'run', side_effect=replies) as run:
                if unattended:
                    cloudflare_demo.arm_deadline(receipt, 2700)
                    self.assertIn('--on-active=2700s', run.call_args_list[1].args[0])
                else:
                    with self.assertRaises(ValueError): cloudflare_demo.arm_deadline(receipt, 2700)
                    run.assert_not_called()

    def test_stale_or_foreign_process_cannot_receive_a_demo_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = Path(tmp)
            target = proc / '123'
            target.mkdir()
            fields = ['0'] * 20
            fields[19] = '987'
            (target / 'stat').write_text('123 (owned demo) ' + ' '.join(fields))
            (target / 'cmdline').write_bytes(b'python3\0scripts/cloudflare-forge-smoke.py\0')
            self.assertTrue(process_matches({'pid': 123, 'start_ticks': '987'}, proc))
            self.assertFalse(process_matches({'pid': 123, 'start_ticks': '986'}, proc))
            (target / 'cmdline').write_bytes(b'python3\0unrelated.py\0')
            self.assertFalse(process_matches({'pid': 123, 'start_ticks': '987'}, proc))
            self.assertFalse(process_matches({'pid': 1, 'start_ticks': '987'}, proc))

    def test_recovery_rejects_changed_resource_identity(self):
        same({'id':'owned','name':'demo'}, {'id':'owned','name':'demo'}, ['id','name'])
        for current in [{'id':'foreign','name':'demo'}, {'id':'owned','name':'other'}, {}]:
            with self.assertRaises(ValueError):
                same(current, {'id':'owned','name':'demo'}, ['id','name'])

    def test_retirement_resumes_a_lost_delete_ack_without_a_second_effect(self):
        original = {'id':'owned','name':'demo'}; current = dict(original); journal = {}; saved = []; deletes = 0
        def save(): saved.append(dict(journal))
        def delete():
            nonlocal current, deletes
            deletes += 1; current = None
            raise RuntimeError('Lost delete acknowledgement')
        with self.assertRaises(RuntimeError): retire_owned('worker', lambda: current, delete, original, ['id','name'], journal, save)
        self.assertEqual(saved[0]['worker'], 'deleting')
        retire_owned('worker', lambda: current, delete, original, ['id','name'], journal, save)
        self.assertEqual(deletes, 1); self.assertEqual(journal['worker'], 'absent')
        with self.assertRaisesRegex(ValueError, 'reappeared'):
            retire_owned('worker', lambda: original, delete, original, ['id','name'], journal, save)

    def test_retirement_requires_current_identity_and_confirmed_absence(self):
        original = {'id':'owned','name':'demo'}; calls = []; journal = {}
        with self.assertRaises(ValueError): retire_owned('bucket', lambda: {'id':'foreign','name':'demo'}, lambda: calls.append('delete'), original, ['id','name'], journal, lambda: None)
        self.assertEqual(calls, [])
        with self.assertRaisesRegex(RuntimeError, 'pending'):
            retire_owned('bucket', lambda: original, lambda: calls.append('delete'), original, ['id','name'], journal, lambda: None)
        self.assertEqual(journal['bucket'], 'deleting')

    def test_missing_timer_cli_path_refuses_before_provider_effects(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'golf-native-20261009-12345678'; directory.mkdir()
            settings = {'worker': directory.name, 'namespace': directory.name, 'account': 'a' * 32, 'database': {'uuid': 'owned'}}
            (directory / 'forge.json').write_text(json.dumps(settings))
            receipt = directory / 'ownership.json'
            state = {'name': directory.name, 'account': settings['account'], 'profile': 'golf', 'resources': {'database': settings['database']}}
            with patch.object(cloudflare_demo_cleanup, 'load_receipt', return_value=(receipt, state)), patch.object(cloudflare_demo_cleanup, 'process_matches', return_value=False), patch.object(cloudflare_demo_cleanup.shutil, 'which', return_value=None), patch.object(cloudflare_demo_cleanup.subprocess, 'run') as provider:
                with self.assertRaisesRegex(ValueError, 'stop timer environment'):
                    cloudflare_demo_cleanup.recover(receipt)
                provider.assert_not_called()

    def test_dead_supervisor_stop_uses_owned_recovery_without_signalling_a_reused_pid(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(cloudflare_demo, 'ROOT', Path(tmp)), patch.object(cloudflare_demo, 'process_matches', return_value=False), patch('cloudflare_demo_cleanup.recover') as recovery, patch.object(cloudflare_demo.os, 'kill') as kill:
            directory = Path(tmp) / '.tmp/cloudflare-forge/run'
            directory.mkdir(parents=True)
            receipt = directory / 'ownership.json'
            receipt.write_text(json.dumps({'demo': {'url':'https://demo.example'}, 'demo_process': {'pid':123}}))
            receipt.chmod(0o600)
            self.assertIn('removed', control('stop', receipt))
            recovery.assert_called_once_with(receipt.resolve()); kill.assert_not_called()
            with self.assertRaises(ValueError):
                control('begin', receipt)


if __name__ == '__main__':
    unittest.main()
