"""Unchanged Requests consumer of the existing owned native-stack launcher."""
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import secrets
import subprocess
import time
import uuid

import smoke

HEAD = '414f0513c33883adf6f2b46901d4f0b38a455851'
WORKFLOW = '.github/workflows/lint.yml'
CATALOG = 'golf.workflow.act.v0.2.89.linux.remote-node24.v1'


def qualify(*, stack, output, directory, actors, command, execute, metadata, rpc, record, stage, environment, values, ci_image, forbidden):
    owner = actors['owner']
    def read_logs(run_id):
        rows, after, size = [], 0, 0
        for _ in range(257):
            page = rpc('owner', 'WorkflowRunService/GetWorkflowRunLogs', {'runId': run_id, 'afterSequence': str(after)})
            for row in page.get('logs', []):
                sequence = int(row['sequence'])
                assert sequence > after
                after = sequence
                size += len(row['text'].encode())
                assert size <= 256 << 10
                rows.append(row)
            if not page.get('hasMore'):
                return ''.join(row['text'] for row in rows)
            assert page.get('logs'), 'Log cursor did not advance'
        raise AssertionError('Log page bound exceeded')
    stage('acquire original Requests Git history without native or controller credentials')
    source = directory / 'requests.git'
    git_environment = {key: value for key, value in environment.items() if not key.startswith(('GIT_', 'GOLF_', 'GITEA_')) and key.upper() not in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')}
    git_environment.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME=str(directory), GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0', LANG='C')

    def git(*argv, native=False, body=None):
        env = git_environment.copy()
        if native:
            env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.'+smoke.GITEA+'/.extraHeader', GIT_CONFIG_VALUE_0='Authorization: Basic '+base64.b64encode(('x-access-token:'+owner['token']).encode()).decode())
        env.update(GIT_AUTHOR_NAME='Golf qualification',GIT_AUTHOR_EMAIL='qualification@example.invalid',GIT_COMMITTER_NAME='Golf qualification',GIT_COMMITTER_EMAIL='qualification@example.invalid')
        result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'http.proxy=', *argv], input=body, env=env, capture_output=True, timeout=180)
        assert result.returncode == 0 and len(result.stdout) <= 16 << 20 and len(result.stderr) <= 1 << 20, 'Bounded native Git failed; private bytes withheld'
        return result.stdout

    git('clone', '--quiet', '--bare', 'https://github.com/psf/requests.git', str(source))
    original = git('-C', str(source), 'show', HEAD+':'+WORKFLOW)
    assert original == (stack/'docs/compatibility/fixtures/requests-lint.yml').read_bytes()
    assert hashlib.sha256(original).hexdigest() == '2adbd62821e06ee622aff3e1e6e283a9cf3e2dcf694a04040b43fd4291d96f99'
    original_tree = git('-C', str(source), 'rev-parse', HEAD+'^{tree}').decode().strip()
    blob = git('-C', str(source), 'rev-parse', HEAD+':'+WORKFLOW).decode().strip()
    native = smoke.provider(owner['token'], 'POST', 'user/repos', {'name':'requests-proof', 'private':True, 'auto_init':False}, expected=201)
    repository = {'owner':owner['name'], 'name':native['name']}
    base = 'repos/'+native['full_name']
    native_url = smoke.GITEA+'/'+native['full_name']+'.git'
    git('-C', str(source), 'push', '--quiet', native_url, HEAD+':refs/heads/source', native=True)
    git('-C', str(source), 'push', '--quiet', native_url, HEAD+'^:refs/heads/proof', native=True)
    smoke.wait_for_push(owner['token'], native['full_name'])
    # A separate empty native reader establishes that the forge actually serves
    # the original source; REST commit.tree.sha is not independent tree evidence.
    native_reader = directory/'native-reader.git'
    git('init', '--bare', '--template=', str(native_reader))
    git('-C', str(native_reader), 'fetch', '--quiet', native_url, HEAD, native=True)
    assert git('-C', str(native_reader), 'rev-parse', 'FETCH_HEAD^{tree}').decode().strip() == original_tree
    assert git('-C', str(native_reader), 'show', HEAD+':'+WORKFLOW) == original
    edited=smoke.provider(owner['token'],'PATCH',base,{'default_branch':'source'})
    assert edited['default_branch']=='source'
    import urllib.request
    request = urllib.request.Request(native_url+'/info/refs?service=git-upload-pack', headers={'Authorization': 'Basic '+base64.b64encode(('x-access-token:'+owner['token']).encode()).decode(), 'Git-Protocol':'version=2'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=20) as response:
        advertisement = response.read((2 << 20)+1)
        assert response.status == 200 and len(advertisement) <= 2 << 20
    record(nativeGitV2Advertisement={'sha256':hashlib.sha256(advertisement).hexdigest(), 'smartHTTPServicePreamble':advertisement.startswith(b'001e# service=git-upload-pack\n0000'), 'version2':b'version 2\n' in advertisement})
    record(proofKind='unchanged-requests-native-push', fixture={'commit':HEAD, 'tree':original_tree, 'workflowBlob':blob, 'workflowSHA256':hashlib.sha256(original).hexdigest(), 'sourceUnmodified':True, 'independentNativeGitReadback':True}, limitations=['Selected public Node24 actions and sponsor-authored push profile; no PR/fork, private remote action or broad Actions parity claim.'])

    stage('current native sponsor, explicit push policy, signed webhook and exact original source')
    target = {'repository':repository, 'repositoryId':str(native['id']), 'ownerId':str(native['owner']['id'])}
    for scope in ('INSTANCE', 'REPOSITORY'):
        selected = {'scope':'EXECUTION_SCOPE_'+scope} | ({'repository':repository} if scope=='REPOSITORY' else {})
        policy = rpc('owner','ExecutionPolicyService/GetExecutionPolicy',selected)['policy']
        rpc('owner','ExecutionPolicyService/UpdateExecutionPolicy',selected | {'scopeId':policy['scopeId'], 'expectedRevision':policy.get('revision','0'), 'expectedAuthorityRevision':policy['authorityRevision'], 'mode':'EXECUTION_MODE_ALL', 'manualDispatchEnabled':True, 'pushAllowed':True, 'allowAllWorkflows':False, 'workflowPaths':[WORKFLOW]})
    grant = rpc('owner','AutomationGrantService/CreateAutomationGrant', {'repository':repository, 'expectedRepositoryId':target['repositoryId'], 'expectedOwnerId':target['ownerId'], 'nativeToken':owner['token'], 'branches':['proof'], 'workflowPaths':[WORKFLOW], 'expiresAt':(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(), 'idempotencyKey':str(uuid.uuid4())})['grant']
    connection, secret = str(uuid.uuid4()), secrets.token_urlsafe(32)
    forbidden.append(secret)
    values.update(GOLF_PUSH_CI_ENABLED='true', GOLF_REPOSITORY_EVENT_CONNECTIONS=json.dumps([{'id':connection, 'repositoryId':target['repositoryId'], 'ownerId':target['ownerId'], 'repository':native['full_name'], 'secret':secret}],separators=(',',':')))
    (directory/'proof.env').write_text(''.join(key+"='"+value+"'\n" for key,value in values.items()))
    command('up','-d','--no-build','--pull','never','--no-deps','golf')
    smoke.ready()
    # The worker shares Golf's network namespace, so bind its proxy address to
    # the recreated core's actual IP immediately before starting that consumer.
    overlay = json.loads((directory/'services.json').read_bytes())
    networks = json.loads(execute('docker','inspect',command('ps','-q','golf')))[0]['NetworkSettings']['Networks']
    assert len(networks)==1
    overlay['services']['runner']['environment']['GOLF_RUNNER_ACTIONS_EGRESS_HOST']=next(iter(networks.values()))['IPAddress']
    (directory/'services.json').write_text(json.dumps(overlay))
    smoke.provider(owner['token'],'POST',base+'/hooks', {'type':'gitea','active':True,'events':['push'],'branch_filter':'*','config':{'url':'http://golf:8080/hooks/forgejo/'+connection,'content_type':'json','http_method':'POST','secret':secret}}, expected=201)
    command('up','-d','--no-build','--pull','never','runner-image-init','runner-actions-image-init')
    command('up','-d','--no-build','--pull','never','runner')
    time.sleep(7)
    git('-C',str(source),'push','--quiet',native_url,HEAD+':refs/heads/proof',native=True)

    stage('actual private checkout, Node24 setup action and unchanged dependency commands')
    deadline = time.monotonic()+180
    admitted = None
    while time.monotonic()<deadline:
        page=rpc('owner','WorkflowRunService/ListWorkflowRuns', {'repository':repository,'page':{'limit':20,'page':1}})
        matching=[run for run in page.get('runs',[]) if run['commitId']==HEAD and run.get('origin')=='WORKFLOW_RUN_ORIGIN_PUSH']
        assert len(matching)<=1
        if matching:
            admitted=matching[0]
            break
        blocked=metadata("SELECT state||':'||reason FROM golf_push_materializations WHERE state='blocked' ORDER BY created_at DESC LIMIT 1")
        if blocked:
            record(admissionRefusal=blocked)
            break
        time.sleep(1)
    assert admitted, 'Original push did not produce one admitted run'
    deadline=time.monotonic()+660
    observed=None
    while time.monotonic()<deadline:
        current=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':admitted['id']})['run']
        record(run={key:current[key] for key in ('id','commitId','state','jobs') if key in current})
        if current['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING'):
            observed=current
            break
        time.sleep(1)
    assert observed
    text=read_logs(observed['id'])
    file=output/'private-requests-output.log';file.write_text(text);file.chmod(0o600)
    assert all(value not in text for value in forbidden) and 'golf_job_git_' not in text
    assert observed['state']=='WORKFLOW_RUN_STATE_SUCCEEDED', 'Unchanged workflow did not succeed'
    assert observed['commitId']==HEAD and observed['workflowBlobId']==blob and observed['engineCatalog']==CATALOG
    assert observed['eventRef']=='refs/heads/proof' and observed['automationGrantId']==grant['id']
    jobs=observed['jobs'];assert len(jobs)==1
    job=jobs[0];assert job['jobId']=='lint' and job['imageDigest']==ci_image and job['state']=='WORKFLOW_STEP_STATE_SUCCEEDED'
    assert [step['id'] for step in job['steps']]==['0','1','2']
    assert all(step['state']=='WORKFLOW_STEP_STATE_SUCCEEDED' for step in job['steps'])
    assert HEAD in text and 'pre-commit' in text and 'Passed' in text
    assert 'Successfully set up CPython (3.14.8)' in text and 'Downloading' in text
    for _ in range(30):
        remaining=command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.attempt='+observed['attemptId'])
        if not remaining:
            break
        time.sleep(1)
    assert not remaining
    assert not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.attempt='+observed['attemptId'])
    assert int(metadata('SELECT count(*) FROM golf_workflow_runs'))==1
    record(run={key:observed[key] for key in ('id','attemptId','commitId','workflowPath','workflowBlobId','sourceSha256','origin','eventRef','state','engineCatalog','engineCommit','jobs')}, originalCheckout=True, immutableRemoteActions=True, dependencyDownloads=True, unchangedRequestsPassed=True, jobTokensMasked=True, actualDockerCleanup={'attemptContainersAbsent':True,'attemptVolumesAbsent':True}, controlAndPublicOriginsIndependent=True)

    # Separate controlled commits exercise refusal and lifecycle boundaries.
    # The original unchanged Requests result above remains independently bound.
    parent=HEAD
    cases=[]
    for case,script,timeout,cancel in [
        ('dependency-boundary-failure', '''set -eu
for address in https://169.254.169.254 https://10.0.0.1 https://example.com; do
  if curl --fail --silent --max-time 5 "$address"; then exit 91; fi
done
if HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= curl --fail --silent --max-time 5 https://pypi.org/simple/; then exit 92; fi
curl --fail --silent --max-time 30 https://pypi.org/simple/pre-commit/ >/dev/null
echo dependency-boundary-passed
exit 23''',2,False),
        ('job-timeout','sleep 120',1,False),
        ('running-cancellation','sleep 120',5,True),
    ]:
        stage('actual '+case+' and exact-owned teardown')
        workflow=('name: Controlled runtime boundary\non: [push]\npermissions: {contents: read}\njobs:\n  lint:\n    runs-on: ubuntu-24.04\n    timeout-minutes: '+str(timeout)+'\n    steps:\n      - id: boundary\n        run: |\n'+''.join('          '+line+'\n' for line in script.splitlines())).encode()
        git('-C',str(source),'read-tree',parent)
        workflow_blob=git('-C',str(source),'hash-object','-w','--stdin',body=workflow).decode().strip()
        git('-C',str(source),'update-index','--add','--cacheinfo','100644,'+workflow_blob+','+WORKFLOW)
        tree=git('-C',str(source),'write-tree').decode().strip()
        head=git('-C',str(source),'commit-tree',tree,'-p',parent,body=(case+'\n').encode()).decode().strip()
        git('-C',str(source),'push','--quiet',native_url,head+':refs/heads/proof',native=True)
        began=time.monotonic();result=None;cancelled=False
        while time.monotonic()-began<180:
            page=rpc('owner','WorkflowRunService/ListWorkflowRuns',{'repository':repository,'page':{'limit':20,'page':1}})
            runs=[run for run in page.get('runs',[]) if run['commitId']==head]
            assert len(runs)<=1
            if not runs:
                blocked=metadata("SELECT reason FROM golf_push_materializations WHERE state='blocked' ORDER BY created_at DESC LIMIT 1")
                if blocked:
                    record(runtimeBoundaryRefusal={'case':case,'reason':blocked})
                    break
            if runs:
                result=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':runs[0]['id']})['run']
                started=any(step.get('state')=='WORKFLOW_STEP_STATE_RUNNING' for job in result.get('jobs',[]) for step in job.get('steps',[]))
                if cancel and started and not cancelled:
                    rpc('owner','WorkflowRunService/CancelWorkflowRun',{'runId':result['id'],'expectedVersion':result['version']})
                    cancelled=True
                    result=rpc('owner','WorkflowRunService/GetWorkflowRun',{'runId':result['id']})['run']
                if result['state'] not in ('WORKFLOW_RUN_STATE_QUEUED','WORKFLOW_RUN_STATE_RUNNING'):
                    break
            time.sleep(1)
        assert result and result['state']==('WORKFLOW_RUN_STATE_CANCELLED' if cancel else 'WORKFLOW_RUN_STATE_FAILED'), 'Controlled runtime outcome differs'
        if cancel:assert cancelled
        boundary=result['jobs'][0]['steps'][0]
        assert boundary['id']=='boundary' and boundary.get('startedAt'), 'Boundary script never started'
        if case=='job-timeout':
            assert time.monotonic()-began<120 and boundary.get('finishedAt')
            elapsed=(datetime.fromisoformat(boundary['finishedAt'].replace('Z','+00:00'))-datetime.fromisoformat(boundary['startedAt'].replace('Z','+00:00'))).total_seconds()
            assert 55 <= elapsed <= 90, 'Job did not enforce the one-minute execution deadline'
        if case=='dependency-boundary-failure':
            text=read_logs(result['id'])
            assert 'dependency-boundary-passed' in text and 'golf_job_git_' not in text and all(value not in text for value in forbidden)
        for _ in range(40):
            remaining=command('exec','-T','runner-daemon','docker','ps','-aq','--filter','label=io.golf.runner.attempt='+result['attemptId'])
            if not remaining:break
            time.sleep(1)
        assert not remaining
        assert not command('exec','-T','runner-daemon','docker','volume','ls','-q','--filter','label=io.golf.runner.attempt='+result['attemptId'])
        cases.append({'id':case,'commit':head,'runId':result['id'],'state':result['state'],'step':boundary,'elapsedSeconds':round(time.monotonic()-began,3),'ownedContainersAndVolumesAbsent':True})
        record(runtimeBoundaryCases=cases)
        parent=head
    assert int(metadata('SELECT count(*) FROM golf_workflow_runs'))==4
