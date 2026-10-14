"""Explicitly publish the reviewed discovery demo through Golf APIs."""
import json
import urllib.request
import time
from cloudflare_setup import private_read, replace_private_json


def publish(directory, root):
    settings = json.loads(private_read(directory/'forge.json'))
    auth = json.loads(private_read(directory/'retained-auth.json'))
    if settings.get('public_repositories') is not True or auth['origin'] != settings['origin']:
        raise ValueError('Deploy public access on the owned installation first')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    opener = urllib.request.build_opener(NoRedirect())
    def http(path, body):
        request = urllib.request.Request(auth['origin']+path, data=json.dumps(body).encode(), headers={
            'Content-Type':'application/json','Connect-Protocol-Version':'1','User-Agent':'GolfNativeForgeQualification/1',
            'Authorization':'Bearer '+auth['token']})
        with opener.open(request, timeout=60) as response: return json.load(response)
    deadline = time.monotonic()+600
    while True:
        request = urllib.request.Request(auth['origin']+'/native/diagnostics', data=b'{}', headers={
            'Content-Type':'application/json','Connect-Protocol-Version':'1','User-Agent':'GolfNativeForgeQualification/1',
            'Authorization':'Bearer '+auth['token']})
        with opener.open(request, timeout=30) as response:
            observation = json.load(response)
            if observation.get('schema', 0) >= 22 and observation.get('configuration') == response.headers.get('X-Golf-Worker-Configuration') and observation.get('release') == response.headers.get('X-Golf-Worker-Release'):
                break
        if time.monotonic() >= deadline: raise RuntimeError('Worker and workspace rollout did not converge; no content was published')
        time.sleep(5)
    seed(http, json.loads((root/'deploy/demo/public.json').read_text()), directory/'public-seed.json')


def seed(http, manifest, journal_path):
    session = http('/rpc/golf.v1.SessionService/GetSession', {})
    if session.get('user', {}).get('login') != manifest['login']:
        raise ValueError('Public demo owner differs')
    journal = json.loads(private_read(journal_path)) if journal_path.exists() else {}
    ids = {}
    for full_name in manifest['repositories']:
        owner, name = full_name.split('/')
        repository = {'owner':owner,'name':name}
        row = http('/rpc/golf.v1.RepositoryService/GetRepository', {'repository':repository})['repository']
        target = {'repository':repository,'repositoryId':row['id']}
        current = http('/native/repository-visibility', {**target,'action':'get'})
        if full_name in journal and (journal[full_name] != row['id'] or not current['isPublic']):
            raise ValueError('Published demo repository changed; inspect before republishing')
        if not current['isPublic']:
            current = http('/native/repository-visibility', {**target,'action':'set','expectedRevision':current['revision'],'isPublic':True})
        if current['repositoryId'] != row['id'] or not current['isPublic']:
            raise ValueError('Public repository readback differs')
        journal[full_name] = row['id']; replace_private_json(journal_path,journal)
        ids[full_name] = row['id']
        topics = manifest.get('topics', {}).get(full_name)
        if topics:
            settings = http('/rpc/golf.v1.RepositorySettingsService/GetRepositorySettings', {'repository':repository})['settings']
            if not settings.get('topics'):
                http('/rpc/golf.v1.RepositorySettingsService/UpdateRepositoryTopics', {**target,
                    'ownerId':settings['ownerId'],'expectedRevision':settings['revision'],'topics':topics})
    for owner, spec in manifest['profiles'].items():
        desired = {**spec,'pinned':[ids[name] for name in spec['pinned']]}
        current = http('/native/public-profile', {'action':'get','owner':owner})
        observed = {key:current[key] for key in desired if key != 'pinned'}
        observed['pinned'] = [row['id'] for row in current['pinnedRepositories']]
        if observed == desired: continue
        if current['enabled']:
            raise ValueError('Public profile '+owner+' was customized; it will not be overwritten')
        result = http('/native/public-profile', {'action':'save','owner':owner,'ownerId':current['ownerId'],
            'expectedRevision':current['revision'],'profile':desired})
        if not result['enabled'] or result['ownerId'] != current['ownerId']:
            raise ValueError('Public profile readback differs')
    print('Public demo verified: '+', '.join(manifest['repositories'])+'; profiles: '+', '.join(manifest['profiles']))
