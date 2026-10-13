"""Prepare the requested demo through supported Golf/Git APIs, without replaying unrelated qualification."""
import json
from cloudflare_setup import private_read, replace_private_json
from pathlib import Path
import shutil
import time
import uuid


def seed(directory, root, workspace, rpc, http, git, record):
    journal = Path(directory)/'playground-seed.json'
    plan = json.loads(private_read(journal)) if journal.exists() else {'repositories': {}}
    def save(): replace_private_json(journal, plan)
    source = Path(directory)/'source'
    if 'source' not in plan:
        if source.exists(): raise RuntimeError('Unjournaled playground source; inspect before recovery')
        git('initialize retained demo source', 'init', '-b', 'main', source)
        for name in ['calc.py', 'worker.mjs', 'schema.sql']:
            shutil.copyfile(Path(root)/'cloudflare/forge/demo'/name, source/name)
        shutil.copytree(Path(root)/'cloudflare/forge/demo/public', source/'public')
        shutil.copyfile(Path(root)/'scripts/fixtures/registry_publish.py', source/'registry_publish.py')
        (source/'README.md').write_text('# Cloudflare CI playground\n\nReal Git, Python tests, OCI publication and private Worker previews.\n'
            'This reviewed example uses the approved Python test profile; arbitrary upstream workflows are not executed.\n')
        (source/'test_calc.py').write_text('import unittest\nfrom calc import add\nclass CalculatorTests(unittest.TestCase):\n'
            '    def test_add(self): self.assertEqual(add(2, 3), 5); __import__("registry_publish").publish()\n')
        git('stage retained source', '-C', source, 'add', '.')
        git('commit retained main source', '-C', source, 'commit', '-m', 'Add reviewed CI and application example')
        base = git('retained main commit', '-C', source, 'rev-parse', 'HEAD').stdout.decode().strip()
        git('create retained feature branch', '-C', source, 'checkout', '-b', 'feature')
        (source/'calc.py').write_text('def add(a, b):\n    return sum((a, b))\n')
        git('stage retained change', '-C', source, 'add', 'calc.py')
        git('commit retained feature', '-C', source, 'commit', '-m', 'Exercise the test and publish pipeline')
        head = git('retained feature commit', '-C', source, 'rev-parse', 'HEAD').stdout.decode().strip()
        plan['source'] = {'base': base, 'head': head}
        save()
    base, head = plan['source']['base'], plan['source']['head']
    if git('verify retained source', '-C', source, 'rev-parse', 'feature').stdout.decode().strip() != head:
        raise RuntimeError('Saved playground source changed')
    previews, repositories, pulls, runs = [], [], [], []
    for name in ['canonical', 'review-playground']:
        saved = plan['repositories'].setdefault(name, {})
        keys = saved.setdefault('keys', {action: str(uuid.uuid4()) for action in ['repository', 'pull', 'job']})
        save()
        repository = saved.get('repository') or rpc('CreateRepository', {'name': name, 'description': 'Reviewed CI, managed OCI images and private Cloudflare previews', 'private': True, 'idempotencyKey': keys['repository']})['repository']
        saved['repository'] = repository
        save()
        key = {'owner': workspace, 'name': name}
        git('push retained main', '-C', source, 'push', repository['cloneUrl'], 'refs/heads/main:refs/heads/main')
        git('push retained feature', '-C', source, 'push', repository['cloneUrl'], 'refs/heads/feature:refs/heads/feature')
        cloned = Path(directory)/('clone-' + name)
        if not cloned.exists(): git('clone retained repository', 'clone', '--branch', 'feature', repository['cloneUrl'], cloned)
        if git('verify retained clone', '-C', cloned, 'rev-parse', 'HEAD').stdout.decode().strip() != head:
            raise RuntimeError('Retained clone identity differs')
        pr = saved.get('pull') or rpc('CreatePullRequest', {'repository': key, 'repositoryId': repository['id'], 'sourceRepository': key, 'sourceRepositoryId': repository['id'],
            'baseBranch': 'main', 'headBranch': 'feature', 'baseCommitId': base, 'headCommitId': head, 'title': 'Run tests and publish a managed image',
            'body': 'This actual source change exercises the approved CI profile and private previews.', 'idempotencyKey': keys['pull']})['pullRequest']
        saved['pull'] = pr
        save()
        selection = {'repository': key, 'repositoryId': repository['id'], 'pullRequestId': pr['id'], 'number': pr['number'], 'baseCommitId': base, 'headCommitId': head}
        job = saved.get('job') or http('/native/pr-evidence', {'action': 'create', 'selection': selection, 'runTests': True, 'advice': False, 'idempotencyKey': keys['job']})['job']
        saved['job'] = job
        save()
        record('ci_admitted', {'repository': name, 'jobId': job['id'], 'commit': head})
        inspection = {'repository': key, 'repositoryId': repository['id'], 'jobId': job['id']}
        for _ in range(240):
            current = http('/native/pr-evidence', {**inspection, 'action': 'status'})['job']
            if current['state'] in ['SUCCEEDED', 'REFUSED', 'EXPIRED']:
                break
            time.sleep(1)
        if current['state'] != 'SUCCEEDED':
            record('ci_failure', current)
            raise RuntimeError('Retained CI did not complete successfully')
        report = http('/native/pr-evidence', {**inspection, 'action': 'report'})['report']
        tests = report.get('tests', {})
        if tests.get('state') != 'PASSED' or tests.get('exitCode') != 0 or tests.get('cleanup') != 'destroyed' or tests.get('commitId') != head or not tests.get('image'):
            record('ci_result_failure', tests)
            raise RuntimeError('Retained CI source, cleanup or image receipt differs')
        packages = http('/native/repository-packages', {'repository': key, 'repositoryId': repository['id'], 'action': 'status'})
        if packages.get('provider') != 'cloudflare' or not any(a['digest'] == tests['image']['digest'] for a in packages.get('artifacts', [])):
            raise RuntimeError('Retained managed image inventory differs')
        context = {'repository': key, 'repositoryId': repository['id'], 'number': pr['number']}
        for _ in range(120):
            items = http('/native/pr-preview', {**context, 'action': 'list'})['previews']
            ready = [p for p in items if p['state'] == 'READY' and not p['purged']]
            if {'STATIC', 'WORKER'} <= {p['kind'] for p in ready}:
                break
            time.sleep(1)
        if not {'STATIC', 'WORKER'} <= {p['kind'] for p in ready}:
            record('preview_failure', items)
            raise RuntimeError('Retained source previews are not ready')
        previews.extend(ready); repositories.append(repository['id']); pulls.append(pr['number']); runs.append({'repository': name, 'jobId': job['id'], 'tests': tests})
        record('ci_verified', runs[-1])
    return {'repository_ids': repositories, 'pull_requests': pulls, 'previews': previews, 'runs': runs, 'human_login_verified': False,
            'preview_lease_seconds': 14400, 'retained': True}
