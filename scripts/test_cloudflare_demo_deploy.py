import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from cloudflare_setup import replace_private_json
from cloudflare_repository_metadata import Metadata

spec = importlib.util.spec_from_file_location('demo_deploy', Path(__file__).with_name('cloudflare-demo-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentAuthorityTest(unittest.TestCase):
    def test_renew_checks_ownership_and_persists_rotation_before_native_enrollment(self):
        for failure in [None, 'database', 'enrollment']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                state = {'state':'retained','demo':{'retained':True},'account':'account','name':'owned','profile':'golf',
                         'resources':{'database':{'uuid':'database'},'preview_service_token':{'id':'service','name':'owned-access'}}}
                settings = {'account':'account','worker':'owned','database':{'uuid':'database'},'origin':'https://demo.example'}
                auth = {'origin':settings['origin'],'token':'golf_native_old','access_client_id':'old-id','access_client_secret':'old-secret'}
                for name, value in [('ownership',state),('forge',settings),('retained-auth',auth)]:
                    replace_private_json(root/(name+'.json'),value)
                calls = []
                def cf(argv, **kwargs):
                    args = argv[3:]; calls.append(args)
                    self.assertEqual(argv[:3], ['cf','--profile','golf'])
                    self.assertEqual(kwargs['env']['CLOUDFLARE_ACCOUNT_ID'], 'account')
                    value = {}
                    if args[:2] == ['d1','get']:
                        value = {'uuid':'database','name':'foreign' if failure=='database' else 'owned'}
                    elif args[:2] == ['d1','query']:
                        body = json.loads(args[-1]); sql = body['sql']
                        if sql.startswith('SELECT'):value = [{'results':[{'id':1,'active':1,'can_create':1,'admin':1}]}]
                        else:
                            saved = json.loads((root/'retained-auth.json').read_text())
                            self.assertEqual(saved['access_client_secret'],'rotated-secret')
                            if sql.startswith('INSERT') and failure=='enrollment':return subprocess.CompletedProcess(argv,1,b'',b'private error')
                            if sql.startswith('UPDATE'):
                                self.assertNotEqual(saved['token'],auth['token'])
                                self.assertEqual(body['params'],[hashlib.sha256(auth['token'].encode()).hexdigest()])
                            value = [{'results':[]}]
                    elif args[:3] == ['zero-trust','access','service-tokens']:
                        self.assertEqual(args[4],'service')
                        value = {'id':'service','name':'owned-access','client_id':'rotated-id','client_secret':'rotated-secret'}
                    return subprocess.CompletedProcess(argv,0,json.dumps(value).encode(),b'')
                with patch.dict(deploy.os.environ,{},clear=True), patch.object(deploy.subprocess,'run',side_effect=cf), contextlib.redirect_stdout(io.StringIO()):
                    if failure:
                        with self.assertRaises((ValueError,RuntimeError)):deploy.renew_authority(root/'ownership.json')
                    else:deploy.renew_authority(root/'ownership.json')
                saved=json.loads((root/'retained-auth.json').read_text())
                if failure=='database':
                    self.assertEqual(len(calls),1); self.assertEqual(saved,auth)
                else:
                    self.assertEqual(saved['access_client_secret'],'rotated-secret')
                    self.assertEqual((root/'retained-auth.json').stat().st_mode & 0o077,0)
                    self.assertEqual(saved['token']==auth['token'],failure=='enrollment')

    def test_create_needs_explicit_content_and_derives_the_admin_login_from_the_email(self):
        base=['create','--account-id','a'*32,'--profile','golf','--workers-subdomain','team','--zone-id','b'*32,
              '--hostname','golf.example.com','--preview-hostname','golf-previews.example.com','--email','Jane.Doe@example.com']
        parser=deploy.build_parser()
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):parser.parse_args(base)
            with self.assertRaises(SystemExit):parser.parse_args(base+['--no-seed','--manifest','deploy/demo/example.json'])
            with self.assertRaises(SystemExit):parser.parse_args(['apply','ownership.json'])
        argv=deploy.create_argv(parser.parse_args(base+['--no-seed']))
        self.assertEqual(argv[argv.index('--admin-login')+1],'jane-doe')
        self.assertEqual(argv[argv.index('--demo-email')+1],'Jane.Doe@example.com')
        self.assertNotIn('--secrets-store-id',argv)
        argv=deploy.create_argv(parser.parse_args(base+['--manifest',str(deploy.ROOT/'deploy/demo/mj.json'),'--admin-login','mike','--secrets-store-id','c'*32]))
        self.assertEqual(argv[argv.index('--admin-login')+1],'mike')
        self.assertEqual(argv[argv.index('--secrets-store-id')+1],'c'*32)
        for login in ['Mike','-mike','m'*40,'a_b']:
            with self.assertRaises(ValueError):deploy.create_argv(parser.parse_args(base+['--no-seed','--admin-login='+login]))

    def test_example_manifest_is_neutral_and_the_hosted_demo_is_explicit(self):
        from cloudflare_demo_manifest import read_manifest
        example=read_manifest(deploy.ROOT/'deploy/demo/example.json')
        self.assertNotIn('personal',example)
        self.assertEqual({r['owner'] for r in example['repositories']},{'example-org'})
        hosted=read_manifest(deploy.ROOT/'deploy/demo/mj.json')
        self.assertEqual(hosted['personal']['login'],'mj')
        self.assertFalse((deploy.ROOT/'deploy/demo/demo.json').exists())
        public=json.loads((deploy.ROOT/'deploy/demo/example-public.json').read_text())
        self.assertNotIn('login',public)
        self.assertTrue(set(public['profiles'])<={o['slug'] for o in example['organizations']})
        self.assertTrue(set(public['repositories'])<={r['owner']+'/'+r['name'] for r in example['repositories']})

    def test_metadata_retries_only_provider_reads(self):
        metadata=object.__new__(Metadata)
        metadata.deadline=None;metadata.profile='golf';metadata.root=Path('.');metadata.env={}
        failed=subprocess.CompletedProcess([],1,b'',b'provider error')
        success=subprocess.CompletedProcess([],0,b'{"name":"owned"}',b'')
        with patch('cloudflare_repository_metadata.subprocess.run',side_effect=[failed,success]) as run, patch('cloudflare_repository_metadata.time.sleep'):
            self.assertEqual(metadata.cf('artifacts','namespaces','repos','get','owned'),{'name':'owned'})
            self.assertEqual(run.call_count,2)
        with patch('cloudflare_repository_metadata.subprocess.run',return_value=failed) as run:
            with self.assertRaises(RuntimeError):metadata.cf('artifacts','namespaces','tokens','create','owned')
            self.assertEqual(run.call_count,1)


if __name__ == '__main__':unittest.main()
