"""Additional bounded schema18 assertions against the actual hosted service principal."""
import time
import hashlib
import secrets
import json
import datetime as dt
import os
import subprocess


def deep_history(source, parent, count=1000):
    """Owned synthetic history, without hooks, credentials, network or worktree edits."""
    assert len(parent) == 40 and all(c in '0123456789abcdef' for c in parent)
    assert 2 <= count <= 1000
    commands = []
    for index in range(1, count + 1):
        commands.append(f'commit refs/heads/qualification-long-head\nmark :{index}\ncommitter Golf qualification <native@example.invalid> {1700000000+index} +0000\ndata 7\nhistory\nfrom {parent if index == 1 else ":"+str(index-1)}\n\n')
    commands.append(f'reset refs/heads/qualification-long-base\nfrom :{count-1}\n\ndone\n')
    env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
           'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.hooksPath', 'GIT_CONFIG_VALUE_0': os.devnull}
    subprocess.run(['git', '-C', str(source), 'fast-import', '--quiet', '--done'], input=''.join(commands).encode(),
                   env=env, capture_output=True, check=True, timeout=30)


def qualify(http, rpc, git, repository, pull, selection, query, reader, source):
    target = {'repository': {'owner': 'alice', 'name': repository['name']}, 'repositoryId': repository['id'],
              'ownerId': '1', 'pullRequestId': pull['id'], 'number': pull['number']}
    result = {'schema': http('/native/diagnostics')['schema'], 'machine_denials': [], 'latency_ms': []}
    assert result['schema'] == 18, 'Hosted schema differs'
    for service, methods in {
        'RepositoryRulesService': ['GetRepositoryRules', 'MutateRepositoryRules', 'GetRepositoryRuleMutation'],
        'GitTransportService': ['GetGitTransport', 'CreateGitCredential', 'ListGitCredentials', 'RevokeGitCredential'],
        'PullReviewRequestService': ['GetPullReviewRequests', 'GetPullReviewTeamCandidates', 'SubmitPullReviewRequest', 'GetPullReviewRequestOperation',
                                    'GetPullReviewLifecycleState', 'SubmitPullReviewLifecycle', 'GetPullReviewLifecycleOperation'],
        'PullReviewAuthoringService': ['GetPullReviewAuthoringState', 'SubmitPullReviewAuthoringOperation', 'GetPullReviewAuthoringOperation'],
    }.items():
        for method in methods:
            path = '/rpc/golf.v1.' + service + '/' + method
            response = http(path, {'target': target} if service == 'PullReviewAuthoringService' else target, expected=404)
            assert response['code'] == 'not_found', 'Machine obtained human-only authority'
            result['machine_denials'].append(method)
    inventory_input = {'repository': target['repository'], 'repositoryId': repository['id'], 'commitId': pull['head']['commitId']}
    inventory = rpc('GetRepositoryFileIndex', inventory_input)
    assert inventory['repositoryId'] == repository['id'] and inventory['commitId'] == pull['head']['commitId']
    expected_paths = git('exact hosted file inventory', '-C', source, 'ls-tree', '-r', '--name-only', '-z', pull['head']['commitId']).stdout.decode().rstrip('\0').split('\0')
    assert sorted(inventory['paths']) == sorted(expected_paths), 'Hosted file finder differs from canonical Git'
    start = time.monotonic()
    assert rpc('GetRepositoryFileIndex', inventory_input) == inventory
    result['file_finder'] = {'files': len(inventory['paths']), 'exact_commit': inventory['commitId'],
                             'warm_ms': round((time.monotonic() - start) * 1000)}
    observation = http('/rpc/golf.v1.PullMergeObservationService/GetPullRequestMergeObservation',
                       {'selection': selection, 'expectedPullRevision': pull['revision']})['observation']
    assert observation['sourceState'] == 'PULL_MERGE_SOURCE_STATE_CURRENT' and observation['nativeCallerCanMerge'] is False
    assert not any(value is True for value in observation['mergeConfiguration'].values())
    result['merge_diagnostics_without_publication'] = True
    deep_history(source, pull['head']['commitId'])
    branches = ['qualification-long-base', 'qualification-long-head']
    commits = []
    for branch in branches:
        commits.append(git('deep history immutable identity', '-C', source, 'rev-parse', branch).stdout.decode().strip())
        git('push owned deep history branch', '-C', source, 'push', repository['cloneUrl'], f'refs/heads/{branch}:refs/heads/{branch}')
    comparison = {'repository': target['repository'], 'repositoryId': repository['id'], 'sourceRepository': target['repository'],
                  'sourceRepositoryId': repository['id'], 'baseBranch': branches[0], 'headBranch': branches[1],
                  'baseCommitId': commits[0], 'headCommitId': commits[1]}
    samples = []
    for _ in range(2):
        start = time.monotonic()
        compared = rpc('GetRepositoryComparison', {'selection': comparison})
        samples.append(round((time.monotonic() - start) * 1000))
        assert compared['selection'] == comparison and len(compared['commits']) == 1
        assert compared['commits'][0]['sha'] == commits[1] and compared.get('rawDiff', '') == ''
    result['deep_history_comparison'] = {'additional_commits': 1000, 'selected_commits': 1, 'milliseconds': samples,
                                       'scope': 'Real Artifacts synthetic history; small unchanged tree, one service principal.'}
    path = '/rpc/golf.v1.PullReviewRequestService/GetPullCodeOwners'
    owners = http(path, {**target, 'selection': selection, 'expectedPullRevision': pull['revision']})
    assert owners['path'] == '.github/CODEOWNERS' and owners['routingComplete'] is True
    assert {'path': 'hello.txt', 'owners': ['@bob']} in owners['matches']
    http(path, {**target, 'selection': selection, 'expectedPullRevision': '0' * 64}, expected=412)
    result['codeowners'] = {'path': owners['path'], 'matches': owners['matches'], 'stale_denied': True}
    git('unlocked comparison branch push', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/qualification-unlocked')
    row = query('SELECT artifact_name FROM repositories WHERE id=?', [repository['id']])[0]['results'][0]
    query('INSERT INTO repository_rules(repository_id,artifact_name,version,branches,tags,next_tag) VALUES(?,?,1,?,?,1)',
          [repository['id'], row['artifact_name'], json.dumps([{'ruleName': 'qualification-locked'}]), '[]'])
    try:
        denied = git('hosted branch lock denial', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/qualification-locked', required=False)
        assert denied.returncode, 'Branch lock did not deny push'
        refs = git('locked branch remains absent', 'ls-remote', repository['cloneUrl'], 'refs/heads/qualification-locked').stdout
        assert not refs, 'Denied branch was created'
    finally:
        query("UPDATE repository_rules SET version=version+1,branches='[]' WHERE repository_id=?", [repository['id']])
    git('formerly locked branch push', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/qualification-locked')
    result['fixture_branch_lock'] = True
    token = 'golf_git_' + secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    now = int(time.time())
    query("INSERT INTO git_credentials(digest,user_id,repository_id,artifact_name,label,mode,identity_version,grant_generation,created_at,expires_at) SELECT ?,2,?,?,'Hosted qualification',1,COALESCE((SELECT version FROM native_identity_versions WHERE user_id=2),0),COALESCE((SELECT generation FROM collaborator_versions WHERE repository_id=? AND user_id=2),0),?,?",
          [digest, repository['id'], row['artifact_name'], repository['id'], now, now+600])
    try:
        assert pull['head']['commitId'].encode() in git('scoped Git credential read', 'ls-remote', repository['cloneUrl'], token=token).stdout
        http('/rpc/golf.v1.SessionService/GetSession', token=token, expected=401)
        assert git('scoped read-only credential cannot push', '-C', source, 'push', repository['cloneUrl'], 'HEAD:refs/heads/credential-denied', token=token, required=False).returncode
    finally:
        query('UPDATE git_credentials SET revoked_at=? WHERE digest=?', [int(time.time()), digest])
    assert git('revoked scoped credential denied', 'ls-remote', repository['cloneUrl'], token=token, required=False).returncode
    result['fixture_scoped_git_read_write_api_and_revocation'] = True
    private_body = 'Private hosted draft ' + secrets.token_hex(12)
    timestamp = dt.datetime.now(dt.timezone.utc).isoformat()
    draft = query("INSERT INTO pull_reviews(pull_request_id,author_id,head_commit,base_commit,state,body,created_at) VALUES(?,2,?,?,'COMMENT',?,?) RETURNING id",
                  [pull['id'], pull['head']['commitId'], pull['base']['commitId'], private_body, timestamp])[0]['results'][0]['id']
    query("INSERT INTO pull_review_drafts(review_id,pull_request_id,author_id,status,updated_at) VALUES(?,?,2,'PENDING',?)", [draft,pull['id'],timestamp])
    try:
        owner_reviews = rpc('ListPullRequestReviews', target)
        assert private_body not in json.dumps(owner_reviews) and all(r['id'] != str(draft) for r in owner_reviews['reviews'])
        own_reviews = rpc('ListPullRequestReviews', target, token=reader)['reviews']
        assert any(r['id'] == str(draft) and r['body'] == private_body for r in own_reviews)
        query("UPDATE pull_review_drafts SET status='DISCARDED' WHERE review_id=?", [draft])
        query("UPDATE pull_reviews SET body='' WHERE id=?", [draft])
        assert all(r['id'] != str(draft) for r in rpc('ListPullRequestReviews', target, token=reader)['reviews'])
    finally:
        query("UPDATE pull_review_drafts SET status='DISCARDED' WHERE review_id=?", [draft])
        query("UPDATE pull_reviews SET body='' WHERE id=?", [draft])
    result['fixture_pending_review_privacy'] = True
    settings_path = '/rpc/golf.v1.RepositorySettingsService/'
    before = http(settings_path + 'GetRepositorySettings', target)['settings']
    update = {'repository': target['repository'], 'repositoryId': repository['id'], 'ownerId': before['ownerId'], 'expectedRevision': before['revision'], 'defaultBranch': 'feature'}
    changed = http(settings_path + 'UpdateRepositorySettings', update)['settings']
    assert changed['defaultBranch'] == 'feature'
    observed = git('hosted configured Git HEAD', 'ls-remote', '--symref', repository['cloneUrl'], 'HEAD').stdout.decode()
    assert 'ref: refs/heads/feature\tHEAD' in observed and pull['head']['commitId'] + '\tHEAD' in observed
    http(settings_path + 'UpdateRepositorySettings', update, expected=412)
    restored = http(settings_path + 'UpdateRepositorySettings', {**update, 'expectedRevision': changed['revision'], 'defaultBranch': before['defaultBranch']})['settings']
    assert restored['defaultBranch'] == before['defaultBranch']
    result['default_branch_git_head_and_stale_write'] = True
    for _ in range(5):
        start = time.monotonic()
        observed = rpc('GetRepository', {'repository': target['repository']})['repository']
        assert observed['id'] == repository['id']
        result['latency_ms'].append(round((time.monotonic() - start) * 1000))
    return result
