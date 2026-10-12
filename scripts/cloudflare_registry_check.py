"""Owned CFCR deployment and real native CI publication for the hosted rehearsal."""
import base64
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

from cloudflare_setup import replace_private_json


class RegistryProof:
    def __init__(self, directory, state, args, cf, command, provider, save, redactions):
        self.directory = Path(directory) / 'registry'
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.root = Path(__file__).resolve().parents[2] / 'golf-cfcr'
        self.state, self.args, self.cf, self.command = state, args, cf, command
        self.provider, self.save, self.redactions = provider, save, redactions
        self.name = state['name'] + '-registry'
        self.origin = 'https://' + args.registry_host
        self.prefix = '/accounts/' + args.account_id
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def provision(self, golf):
        for kind in ['workers', 'r2']:
            argv = ['workers', 'get', self.name] if kind == 'workers' else ['r2', 'buckets', 'get', self.name]
            result = self.command('fresh registry ' + kind, ['cf', '--profile', self.args.profile, *argv], required=False)
            if not result.returncode or b'404 Not Found' not in result.stderr:
                raise RuntimeError('Registry target absence unconfirmed')
        if any(row['hostname'] == self.args.registry_host for row in self.provider(self.prefix + '/workers/domains')):
            raise RuntimeError('Registry domain already allocated')
        bucket = self.cf('owned registry bucket', 'r2', 'buckets', 'create', '--name', self.name)
        if bucket['name'] != self.name: raise RuntimeError('Registry bucket identity differs')
        self.state['resources']['registry_bucket'] = bucket
        self.save()
        if self.cf('registry bucket privacy', 'r2', 'buckets', 'domains', 'managed', 'list', '--bucket-name', self.name)['enabled']:
            raise RuntimeError('Registry bucket must be private')
        self.settings = {'account': self.args.account_id, 'worker': self.name, 'bucket': self.name,
                         'origin': self.origin, 'golfWorker': golf['worker'], 'golfOrigin': golf['origin']}
        if self.args.registry_scanner_image:
            original = self.command('approved scanner identity', ['docker', 'image', 'inspect', self.args.registry_scanner_image])
            image = json.loads(original.stdout)[0]
            if image['Os'] != 'linux' or image['Architecture'] != 'amd64' or not re.fullmatch(r'sha256:[a-f0-9]{64}', image['Id']):
                raise RuntimeError('Hosted scanner requires the approved Linux AMD64 image')
            tag = self.name + ':scanner'
            self.state['resources']['registry_image'] = {'tag': tag, 'id': image['Id']}
            self.save()
            self.command('tag owned scanner image', ['docker', 'tag', image['Id'], tag])
            self.settings['scanner'] = {'image': tag, 'imageId': image['Id']}
        replace_private_json(self.directory / 'registry.json', self.settings)
        for path in [*self.root.glob('src/*.mjs'), self.root/'scripts/prepare.mjs', self.root/'scripts/hosted-clients.mjs', Path(__file__)]:
            self.state['source_sha256']['cfcr/' + str(path.relative_to(self.root)) if self.root in path.parents else 'scripts/' + path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.state['registry_attempted'] = True
        self.save()
        self.command('prepare owned registry', ['node', 'scripts/prepare.mjs', str(self.directory)], cwd=self.root)
        self.command('deploy owned registry', ['cf', '--profile', self.args.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=self.directory, timeout=900)
        worker = self.cf('registry worker identity', 'workers', 'get', self.name)
        if worker['name'] != self.name: raise RuntimeError('Registry Worker identity differs')
        self.state['resources']['registry_worker'] = {'id': worker['id'], 'name': worker['name']}
        domains = [row for row in self.provider(self.prefix + '/workers/domains') if row['hostname'] == self.args.registry_host]
        if len(domains) != 1 or domains[0]['service'] != self.name or domains[0]['zone_id'] != self.args.app_zone:
            raise RuntimeError('Registry custom domain identity differs')
        self.state['resources']['registry_domain'] = domains[0]
        self.save()
        golf['registry'] = {'worker': self.name, 'origin': self.origin, 'ci': True}

    def request(self, path, method='GET', data=None, credential=None, token=None, headers=None, expected=200):
        headers = {'User-Agent': 'GolfRegistryQualification/1', **(headers or {})}
        if credential: headers['Authorization'] = 'Basic ' + base64.b64encode(('golf:' + credential).encode()).decode()
        if token: headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(self.origin + path, method=method, data=data, headers=headers)
        try: response = self.client.open(request, timeout=90)
        except urllib.error.HTTPError as error: response = error
        with response:
            body = response.read(9 * 1024**2 + 1)
            if response.status != expected or len(body) > 9 * 1024**2:
                raise RuntimeError(f'Registry {method} {path.split("?")[0]} returned {response.status}; expected {expected}')
            return response.headers, body

    def package(self, http, repository, action, **values):
        return http('/native/repository-packages', {'repository': {'owner': 'alice', 'name': repository['name']},
                    'repositoryId': repository['id'], 'action': action, **values})

    def enable(self, http, repository):
        self.package(http, repository, 'enable')

    def qualify(self, http, rpc, repository, tests):
        image = tests.get('image')
        if not image or image['commitId'] != tests['commitId'] or image['repository'] != 'alice/' + repository['name']:
            raise RuntimeError('Actual native CI did not publish a bound registry receipt')
        issued = self.package(http, repository, 'credential')
        self.redactions.append(issued['credential'])
        _, raw = self.request('/token?service=cfcr&scope=repository:' + image['repository'] + ':pull,push', credential=issued['credential'])
        token = json.loads(raw)['token']; self.redactions.append(token)
        headers, raw = self.request('/v2/' + image['repository'] + '/manifests/' + image['tag'], token=token)
        if 'sha256:' + hashlib.sha256(raw).hexdigest() != image['digest'] or headers['Docker-Content-Digest'] != image['digest']:
            raise RuntimeError('Independent hosted CI manifest digest differs')
        self.state['checks']['registry_ci'] = {'image': image, 'manifestBytes': len(raw), 'independentDigestVerified': True,
                                             'containerCleanup': tests['cleanup']}
        self.save()
        import uuid
        fixture = rpc('CreateRepository', {'name': 'registry-clients', 'private': True, 'idempotencyKey': str(uuid.uuid4())})['repository']
        self.enable(http, fixture)
        credentials = self.package(http, fixture, 'credential')
        self.redactions.append(credentials['credential'])
        oci = rpc('CreateRepository', {'name': 'registry-conformance', 'private': True, 'idempotencyKey': str(uuid.uuid4())})['repository']
        self.enable(http, oci)
        oci_credential = self.package(http, oci, 'credential')['credential']
        self.redactions.append(oci_credential)
        config = {'ociName': 'alice/' + oci['name'], 'ociCredential': oci_credential, 'origin': self.origin, 'name': 'alice/' + fixture['name'], 'credential': credentials['credential'],
                  'ciImage': self.origin.removeprefix('https://') + '/' + image['repository'] + '@' + image['digest'],
                  'ciCredential': issued['credential']}
        path = self.directory / 'clients.json'; replace_private_json(path, config)
        try:
            self.command('real hosted registry clients', ['node', 'scripts/hosted-clients.mjs', str(path)], cwd=self.root, timeout=900)
            self.state['checks']['registry_clients'] = json.loads(path.with_name('clients-receipt.json').read_text())
        finally: path.unlink(missing_ok=True)
        # Mutate only this proof's Golf coordination grant; exercise already-issued tokens.
        _, raw = self.request('/token?service=cfcr&scope=repository:' + image['repository'] + ':pull,push', credential=issued['credential'])
        current_token = json.loads(raw)['token']; self.redactions.append(current_token)
        database = self.state['resources']['database']['uuid']
        def grant(sql):
            return self.cf('owned registry grant fence', 'd1', 'query', database,
                '--body', json.dumps({'sql': sql, 'params': [repository['id']]}))
        original = grant('SELECT role FROM grants WHERE user_id=1 AND repository_id=?')[0]['results']
        if original != [{'role': 'admin'}]: raise RuntimeError('Registry proof grant identity differs')
        try:
            grant("UPDATE grants SET role='read' WHERE user_id=1 AND repository_id=?")
            self.request('/v2/' + image['repository'] + '/manifests/' + image['digest'], token=current_token)
            self.request('/v2/' + image['repository'] + '/blobs/uploads/', method='POST', data=b'', token=current_token, expected=403)
            grant('DELETE FROM grants WHERE user_id=1 AND repository_id=?')
            self.request('/v2/' + image['repository'] + '/manifests/' + image['digest'], token=current_token, expected=403)
            self.request('/token?service=cfcr&scope=repository:' + image['repository'] + ':pull', credential=issued['credential'], expected=403)
        finally:
            grant("INSERT INTO grants(repository_id,user_id,role) VALUES(?,1,'admin') ON CONFLICT(repository_id,user_id) DO UPDATE SET role='admin'")
        self.state['checks']['registry_live_authority'] = {'downgradeDeniesPush': True, 'downgradePreservesPull': True, 'revocationDeniesExistingToken': True, 'revocationDeniesExchange': True, 'grantRestored': True}
        self.package(http, fixture, 'revoke')
        self.request('/token?service=cfcr&scope=repository:' + config['name'] + ':pull', credential=credentials['credential'], expected=401)
        self.state['checks']['registry_credential_revocation'] = True
        self.save()
        if self.args.registry_scanner_image:
            import uuid
            admitted = self.package(http, repository, 'scan', reference=image['digest'], idempotencyKey=str(uuid.uuid4()))
            if len(admitted['jobs']) != 1: raise RuntimeError('Unexpected scanner admission count')
            job_id = admitted['jobs'][0]['id']
            for _ in range(180):
                jobs = self.package(http, repository, 'jobs', reference=image['digest'])['items']
                job = next(row for row in jobs if row['id'] == job_id)
                if job['state'] in ['succeeded', 'failed', 'cancelled']: break
                time.sleep(3)
            self.state['checks']['registry_scanner'] = job
            self.save()
            if job['state'] != 'succeeded' or len(job.get('reports', {})) != 5:
                raise RuntimeError('Hosted native scanner did not produce five completed reports')

    def current_worker(self):
        probe = self.command('registry identity', ['cf', '--profile', self.args.profile, 'workers', 'get', self.name], required=False)
        if probe.returncode and b'404 Not Found' in probe.stderr: return None
        if probe.returncode: raise RuntimeError('Registry Worker identity unavailable')
        current = json.loads(probe.stdout)
        original = self.state['resources'].get('registry_worker', {})
        if current['name'] != self.name or original and current['id'] != original['id']:
            raise RuntimeError('Registry Worker ownership changed')
        return current

    def retire(self):
        if not self.state.get('registry_attempted') or not self.current_worker(): return
        self.command('retire registry classes', ['node', 'scripts/prepare.mjs', str(self.directory), 'retire'], cwd=self.root)
        self.command('deploy registry retirement', ['cf', '--profile', self.args.profile, 'deploy', '--prebuilt', '--provision', 'false'], cwd=self.directory, timeout=180)

    def remove(self):
        current = self.current_worker() if self.state.get('registry_attempted') else None
        if current:
            if current['name'] != self.name: raise RuntimeError('Registry Worker ownership changed')
            domains = [row for row in self.provider(self.prefix + '/workers/domains') if row['service'] == self.name]
            for row in domains:
                if row['hostname'] != self.args.registry_host or row['zone_id'] != self.args.app_zone: raise RuntimeError('Registry domain ownership changed')
                self.provider(self.prefix + '/workers/domains/' + row['id'], 'DELETE')
            self.cf('delete owned registry Worker', 'workers', 'delete', current['id'], '--force')
            probe = self.command('registry Worker absence', ['cf', '--profile', self.args.profile, 'workers', 'get', self.name], required=False)
            if not probe.returncode or b'404 Not Found' not in probe.stderr: raise RuntimeError('Registry Worker remains')
            namespaces = self.cf('registry namespace absence', 'durable-objects', 'namespaces', 'list', '--per-page', '100')
            if len(namespaces) >= 100 or any(row.get('script') == self.name for row in namespaces): raise RuntimeError('Registry Durable Object namespace remains')
        if self.state['resources'].get('registry_image'):
            applications = self.cf('registry scanner applications', 'containers', 'applications', 'list', '--name', self.name + '-scanner', '--per-page', '10')
            if len(applications) >= 10 or any(row['name'] != self.name + '-scanner' for row in applications): raise RuntimeError('Scanner application ownership differs')
            for row in applications: self.cf('delete scanner application', 'containers', 'applications', 'delete', row['id'], '--force')
            if self.cf('scanner application absence', 'containers', 'applications', 'list', '--name', self.name + '-scanner', '--per-page', '10'): raise RuntimeError('Scanner application remains')
            tag = self.state['resources']['registry_image']['tag']
            self.cf('delete scanner image', 'containers', 'images', 'delete', tag, '--force', required=False)
            if self.cf('scanner image absence', 'containers', 'images', 'list', '--filter', '^' + self.name + '$'): raise RuntimeError('Scanner image remains')
            self.command('remove owned scanner tag', ['docker', 'image', 'rm', tag], required=False)
        if self.state['resources'].get('registry_bucket'):
            probe = self.command('registry bucket identity', ['cf', '--profile', self.args.profile, 'r2', 'buckets', 'get', self.name], required=False)
            if probe.returncode and b'404 Not Found' in probe.stderr: return
            if probe.returncode: raise RuntimeError('Registry bucket identity unavailable')
            current = json.loads(probe.stdout)
            original = self.state['resources']['registry_bucket']
            if any(current[k] != original[k] for k in ['name', 'creation_date']): raise RuntimeError('Registry bucket ownership changed')
            rows = self.cf('owned registry objects', 'r2', 'objects', 'list', '--bucket-name', self.name, '--per-page', '1000')
            objects = rows if isinstance(rows, list) else rows['objects']
            if len(objects) >= 1000 or isinstance(rows, dict) and rows.get('truncated'): raise RuntimeError('Registry cleanup inventory exceeds bound')
            for row in objects: self.cf('delete registry object', 'r2', 'objects', 'delete', row['key'], '--bucket-name', self.name, '--force')
            self.cf('delete owned registry bucket', 'r2', 'buckets', 'delete', self.name, '--force')
            probe = self.command('registry bucket absence', ['cf', '--profile', self.args.profile, 'r2', 'buckets', 'get', self.name], required=False)
            if not probe.returncode or b'404 Not Found' not in probe.stderr: raise RuntimeError('Registry bucket remains')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_): return None
