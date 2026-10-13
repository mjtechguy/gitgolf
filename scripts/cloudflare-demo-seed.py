"""Populate an explicitly retained demo with verified public Git snapshots; execute no upstream code."""
import argparse
from http.client import RemoteDisconnected
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

from cloudflare_setup import replace_private_json

SOURCES = [
    ('requests', 'psf/requests'), ('flask', 'pallets/flask'), ('httpx', 'encode/httpx'),
    ('starlette', 'encode/starlette'), ('click', 'pallets/click'), ('rich', 'Textualize/rich'),
    ('pytest', 'pytest-dev/pytest'), ('pydantic', 'pydantic/pydantic'), ('attrs', 'python-attrs/attrs'),
    ('fastapi', 'fastapi/fastapi'),
]


def run(argv, env=None, timeout=120):
    with subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as child:
        try:
            out, _ = child.communicate(timeout=timeout)
        except BaseException:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise
    if child.returncode:
        raise RuntimeError(argv[0] + ' failed with exit ' + str(child.returncode))
    return out.decode().strip()


def git_environment(token=None):
    env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0'}
    config = [('credential.helper', ''), ('core.hooksPath', os.devnull), ('http.followRedirects', 'false')]
    if token:
        if not isinstance(token, str) or not re.fullmatch(r'[\x21-\x7e]{1,2048}', token):
            raise ValueError('Invalid provider credential')
        config.append(('http.extraHeader', 'Authorization: Bearer ' + token))
    env['GIT_CONFIG_COUNT'] = str(len(config))
    for i, (key, value) in enumerate(config):
        env['GIT_CONFIG_KEY_' + str(i)] = key
        env['GIT_CONFIG_VALUE_' + str(i)] = value
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt', type=Path)
    parser.add_argument('--while-preparing', action='store_true', help='Populate the already deployed private installation while CI is being verified')
    parser.add_argument('--ci', action='store_true', help='Build and publish the reviewed demo package CI for the ten imported repositories')
    parser.add_argument('--manifest', type=Path, help='Pinned personal and organization demo inputs')
    args = parser.parse_args()
    from cloudflare_demo_manifest import read_manifest
    manifest = read_manifest(args.manifest) if args.manifest else None
    specs = {r['name']: r for r in manifest['repositories']} if manifest else {}
    sources = [(r['name'], r['upstream'].removeprefix('https://github.com/')) for r in specs.values()] if manifest else SOURCES
    receipt = args.receipt.resolve()
    state = json.loads(receipt.read_text())
    if state.get('state') not in (['retained', 'needs_repair', 'running'] if args.while_preparing else ['retained', 'needs_repair']) or not state.get('demo', {}).get('retained'):
        parser.error('Use an explicitly retained demo receipt')
    auth_path = receipt.parent/'retained-auth.json'
    if auth_path.is_symlink() or auth_path.stat().st_mode & 0o077:
        raise ValueError('Private retained authority is required')
    auth = json.loads(auth_path.read_text())
    settings = json.loads((receipt.parent/'forge.json').read_text())
    if auth['origin'] != settings['origin'] or settings['account'] != state['account'] or settings['namespace'] != state['name']:
        raise ValueError('Retained installation identity changed')
    output = receipt.parent/'seed-receipt.json'
    results = json.loads(output.read_text()) if output.exists() else {'schema': 'golf.demo.public-snapshots.v1', 'repositories': []}
    completed = {r['name'] for r in results['repositories'] if r.get('state') == 'verified'}
    def cf(*argv):
        return json.loads(run(['cf', '--profile', state['profile'], *map(str, argv)]))
    def http(path, body):
        request = urllib.request.Request(auth['origin'] + path, data=json.dumps(body).encode(), headers={
            'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'User-Agent': 'GolfNativeForgeQualification/1', 'Authorization': 'Bearer ' + auth['token'],
            'CF-Access-Client-Id': auth['access_client_id'], 'CF-Access-Client-Secret': auth['access_client_secret']})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None
        retryable = path.rsplit('/',1)[-1].startswith(('Get','List')) or bool(body.get('idempotencyKey')) or body.get('action') in ['status','report']
        for attempt in range(4):
            try:
                with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                if not retryable or error.code<500 or attempt==3: raise
            except (TimeoutError, urllib.error.URLError, RemoteDisconnected, json.JSONDecodeError):
                if not retryable or attempt==3: raise
            time.sleep(attempt+1)
    def rpc(method, body):
        return http('/rpc/golf.v1.RepositoryService/' + method, body)
    for name, upstream in sources:
        if name in completed:
            if manifest:
                item = next(r for r in results['repositories'] if r['name']==name)
                if item['commit'] != specs[name]['commit'] or item['upstream'] != specs[name]['upstream']:
                    raise ValueError('Pinned snapshot differs from the retained import')
                observed = rpc('GetRepository',{'repository':{'owner':specs[name]['owner'],'name':name},'repositoryId':item['repository_id']})
                if observed['repository']['id'] != item['repository_id'] or observed['sourceSelection']['commitId'] != item['commit']:
                    raise ValueError('Retained repository owner or upstream main changed')
                item.update(owner=specs[name]['owner'],dependencies=specs[name].get('dependencies',[]))
                if item.get('ci',{}).get('number'): item['ci']['url']=settings['origin']+'/'+item['owner']+'/'+name+'/pull/'+str(item['ci']['number'])
                replace_private_json(output, results)
            continue
        item = next((r for r in results['repositories'] if r['name'] == name), None)
        if item is None:
            item = {'name': name, 'upstream': 'https://github.com/' + upstream, 'operation_key': str(uuid.uuid4()), 'state': 'preparing'}
            results['repositories'].append(item)
        if manifest: item.update(owner=specs[name]['owner'],dependencies=specs[name].get('dependencies',[]))
        replace_private_json(output, results)
        token = None
        try:
            with tempfile.TemporaryDirectory(prefix='golf-public-snapshot-') as temporary:
                source = Path(temporary)/'source.git'
                if manifest:
                    run(['git','init','--bare',str(source)],git_environment())
                    run(['git','-C',str(source),'fetch','--depth','1',item['upstream']+'.git',specs[name]['commit']],git_environment())
                    run(['git','-C',str(source),'update-ref','HEAD',specs[name]['commit']],git_environment())
                else:
                    run(['git', 'clone', '--bare', '--depth', '1', item['upstream'] + '.git', str(source)], git_environment())
                commit = run(['git', '-C', str(source), 'rev-parse', 'HEAD'], git_environment())
                tree = run(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}'], git_environment())
                if sum(p.stat().st_size for p in source.rglob('*') if p.is_file()) > 25 * 1024 * 1024:
                    raise ValueError('Snapshot exceeds this demo import limit')
                repository = rpc('CreateRepository', {**({'owner': item['owner']} if manifest else {}), 'name': name, 'description': 'Public upstream snapshot from ' + item['upstream'] + '; upstream workflows are not executed.', 'private': True, 'idempotencyKey': item['operation_key']})['repository']
                item['repository_id'] = repository['id']
                query = cf('d1', 'query', settings['database']['uuid'], '--body', json.dumps({'sql': 'SELECT artifact_name FROM repositories WHERE id=? AND name=? AND state=\'ACTIVE\'', 'params': [repository['id'], name]}))
                rows = query[0]['results']
                if len(rows) != 1 or not re.fullmatch(r'repo-[a-f0-9]{32}', rows[0]['artifact_name']):
                    raise ValueError('Native repository identity differs')
                artifact = rows[0]['artifact_name']
                remote = 'https://' + settings['account'] + '.artifacts.cloudflare.net/git/' + settings['namespace'] + '/' + artifact + '.git'
                token = cf('artifacts', 'namespaces', 'tokens', 'create', settings['namespace'], '--repo', artifact, '--scope', 'write', '--ttl', '600')
                item.update(state='uploading', commit=commit, tree=tree, shallow=True)
                replace_private_json(output, results)
                run(['git', '-C', str(source), 'push', '--', remote, 'HEAD:refs/heads/main'], git_environment(token['plaintext']))
                observed = run(['git', 'ls-remote', '--exit-code', remote, 'refs/heads/main'], git_environment(token['plaintext'])).split()[0]
                if observed != commit:
                    raise ValueError('Imported Git head differs from upstream snapshot')
                item.update(state='verified', source_history='shallow snapshot', upstream_workflows_executed=False)
        except Exception as error:
            item.update(state='failed', error=str(error)[:256])
        finally:
            if token:
                cf('artifacts', 'namespaces', 'tokens', 'revoke', token['id'], '--namespace', settings['namespace'], '--force')
            replace_private_json(output, results)
        print(json.dumps({'repository': name, 'state': item['state'], 'commit': item.get('commit')}), flush=True)
    imported = all(any(r['name'] == name and r.get('state') == 'verified' for r in results['repositories']) for name, _ in sources)
    if imported and args.ci:
        from cloudflare_demo_ci import seed
        return seed(receipt, results, sources, settings, cf, rpc, http, run, git_environment)
    return 0 if imported else 1


if __name__ == '__main__':
    raise SystemExit(main())
