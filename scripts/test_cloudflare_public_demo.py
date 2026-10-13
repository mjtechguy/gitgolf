import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from io import BytesIO
from cloudflare_public_demo import seed, publish

class PublicSeed(unittest.TestCase):
    def test_publication_waits_for_workspace_release_and_configuration(self):
        def response(release, configuration):
            value = BytesIO(json.dumps({'schema':22,'release':release,'configuration':configuration}).encode())
            value.headers = {'X-Golf-Worker-Release':'new','X-Golf-Worker-Configuration':'current'}
            return value
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'deploy/demo').mkdir(parents=True)
            (root/'deploy/demo/public.json').write_text('{}')
            with patch('cloudflare_public_demo.private_read', side_effect=[json.dumps({'public_repositories':True,'origin':'https://golf.test'}),json.dumps({'origin':'https://golf.test','token':'test'})]), patch('cloudflare_public_demo.urllib.request.build_opener') as opener, patch('cloudflare_public_demo.time.sleep') as sleep, patch('cloudflare_public_demo.seed') as seed_call:
                opener.return_value.open.side_effect = [response('old','current'),response('new','old'),response('new','current')]
                publish(root,root)
                self.assertEqual(opener.return_value.open.call_count,3)
                self.assertEqual(sleep.call_count,2)
                seed_call.assert_called_once()

    def test_explicit_seed_is_repeatable_and_refuses_republication_or_profile_overwrite(self):
        desired = {'enabled':True,'displayName':'MJ','bio':'Public','location':'','website':'','readme':'Hello','pinned':['mj/fastapi']}
        manifest = {'login':'mj','repositories':['mj/fastapi'],'profiles':{'mj':desired},'topics':{'mj/fastapi':['python']}}
        visibility = {'repositoryId':'9','isPublic':False,'revision':'revision'}
        profile = {**desired,'enabled':False,'ownerId':'1','revision':'revision','pinnedRepositories':[]}
        writes = []; topics = []
        def http(path, body):
            if path.endswith('GetSession'): return {'user':{'login':'mj'}}
            if path.endswith('GetRepositorySettings'): return {'settings':{'topics':list(topics),'ownerId':'1','revision':'revision'}}
            if path.endswith('UpdateRepositoryTopics'): topics.extend(body['topics']);writes.append(path);return {}
            if path.endswith('GetRepository'):
                self.assertEqual(body['repository'], {'owner':'mj','name':'fastapi'})
                return {'repository':{'id':'9'}}
            if path.endswith('repository-visibility'):
                if body['action'] == 'set': visibility['isPublic'] = body['isPublic']; writes.append(path)
                return dict(visibility)
            if body['action'] == 'save':
                profile.update(body['profile']);profile['pinnedRepositories']=[{'id':'9'}];writes.append(path)
            return dict(profile)
        with tempfile.TemporaryDirectory() as temporary:
            journal=Path(temporary)/'receipt.json'
            seed(http,manifest,journal); self.assertEqual(len(writes),3)
            seed(http,manifest,journal); self.assertEqual(len(writes),3)
            self.assertEqual(json.loads(journal.read_text()), {'mj/fastapi':'9'})
            visibility['isPublic']=False
            with self.assertRaisesRegex(ValueError,'republishing'): seed(http,manifest,journal)
            visibility['isPublic']=True; profile['readme']='User customization'
            with self.assertRaisesRegex(ValueError,'customized'): seed(http,manifest,journal)
            self.assertEqual(len(writes),3)

if __name__ == '__main__': unittest.main()
