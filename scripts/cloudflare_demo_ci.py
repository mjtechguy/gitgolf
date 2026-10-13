"""Retained public demo CI through supported repository, Git and evidence APIs."""
import hashlib
import urllib.request
import json
from pathlib import Path
import shutil
import subprocess
import time
import uuid
from cloudflare_setup import replace_private_json


def seed(receipt, results, sources, settings, cf, rpc, http, run, git_environment):
    fixtures = Path(__file__).parent/'fixtures'
    output = receipt.parent/'seed-receipt.json'
    def save(): replace_private_json(output, results)
    for name, _ in sources:
        item = next(r for r in results['repositories'] if r['name']==name)
        ci = item.setdefault('ci', {'state':'preparing','pr_key':str(uuid.uuid4()),'job_key':str(uuid.uuid4())})
        if ci['state']=='verified': continue
        token = None
        try:
            rows = cf('d1','query',settings['database']['uuid'],'--body',json.dumps({'sql':"SELECT artifact_name FROM repositories WHERE id=? AND name=? AND state='ACTIVE'",'params':[item['repository_id'],name]}))[0]['results']
            if len(rows)!=1: raise ValueError('Imported repository changed')
            artifact=rows[0]['artifact_name']
            if not artifact.startswith('repo-') or len(artifact)!=37: raise ValueError('Invalid repository identity')
            remote='https://'+settings['account']+'.artifacts.cloudflare.net/git/'+settings['namespace']+'/'+artifact+'.git'
            token=cf('artifacts','namespaces','tokens','create',settings['namespace'],'--repo',artifact,'--scope','write','--ttl','600')
            source=receipt.parent/'demo-source'/name
            source.parent.mkdir(exist_ok=True,mode=0o700)
            private=git_environment(token['plaintext']); public=git_environment()
            if not source.exists(): run(['git','clone','--branch','main','--',remote,str(source)],private)
            if 'commit' not in ci:
                if run(['git','-C',str(source),'rev-parse','main'],public)!=item['commit']: raise ValueError('Imported base changed')
                run(['git','-C',str(source),'checkout','-B','demo-ci','main'],public)
                demo=source/'.golf';demo.mkdir(exist_ok=True)
                for filename in ['demo_project_ci.py','registry_publish.py']: shutil.copyfile(fixtures/filename,demo/filename)
                (demo/'demo-project.json').write_text(json.dumps({k:item[k] for k in ['name','upstream','commit']},indent=2)+'\n')
                if item.get('dependencies'):
                    dependencies=demo/'dependencies';dependencies.mkdir(exist_ok=True)
                    for dep in item['dependencies']:
                        with urllib.request.urlopen(dep['url'],timeout=30) as response: data=response.read(8*1024*1024+1)
                        if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!=dep['sha256']: raise ValueError('Pinned build dependency differs')
                        (dependencies/dep['name']).write_bytes(data)
                test=source/'test_calc.py'
                wrapper="import runpy, unittest\nclass UpstreamPackageCI(unittest.TestCase):\n    def test_build_and_smoke(self): runpy.run_path('.golf/demo_project_ci.py')['main']()\n"
                if test.exists() and test.read_text()!=wrapper: raise ValueError('Demo test path conflicts with upstream')
                test.write_text(wrapper)
                run(['git','-C',str(source),'add','-f','.golf','test_calc.py'],public)
                run(['git','-C',str(source),'-c','user.name=Golf Demo','-c','user.email=demo@golf.local','commit','-m','Add reviewed offline package build, functional smoke and OCI artifacts'],public)
                ci['commit']=run(['git','-C',str(source),'rev-parse','HEAD'],public);save()
            if run(['git','-C',str(source),'rev-parse','HEAD'],public)!=ci['commit']: raise ValueError('Demo CI source changed')
            if not ci.get('preflight'):
                checked=subprocess.run(['docker','run','--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only',
                    '--tmpfs','/workspace:rw,size=256m,uid=1000,gid=1000,exec','--tmpfs','/tmp:rw,size=128m,mode=1777,exec',
                    '--mount','type=bind,source='+str(source.resolve())+',target=/source,readonly','--workdir','/workspace','--entrypoint','/bin/sh',settings['tests']['image_id'],
                    '-c','cp -R /source /workspace/repo && cd /workspace/repo && python3 -m unittest -v test_calc'],capture_output=True,text=True,timeout=120)
                (receipt.parent/(name+'-preflight.log')).write_text(checked.stdout+checked.stderr)
                if checked.returncode: raise RuntimeError('Offline package preflight failed; inspect '+name+'-preflight.log')
                ci['preflight']=True;save()
            run(['git','-C',str(source),'push','--',remote,'HEAD:refs/heads/demo-ci'],private)
            key={'owner':item.get('owner',settings['workspace']),'name':name}
            if 'number' not in ci:
                pr=rpc('CreatePullRequest',{'repository':key,'repositoryId':item['repository_id'],'sourceRepository':key,'sourceRepositoryId':item['repository_id'],
                    'baseBranch':'main','headBranch':'demo-ci','baseCommitId':item['commit'],'headCommitId':ci['commit'],'title':'Build upstream package and publish demo artifacts',
                    'body':'Reviewed offline wheel build and functional smoke against this actual upstream source. Publishes the wheel, source archive and JSON test report as an OCI artifact. Full upstream workflow matrices are not executed.','idempotencyKey':ci['pr_key']})['pullRequest']
                ci.update(number=pr['number'],pull_request_id=pr['id']);save()
            if 'job_id' not in ci:
                selection={'repository':key,'repositoryId':item['repository_id'],'pullRequestId':ci['pull_request_id'],'number':ci['number'],'baseCommitId':item['commit'],'headCommitId':ci['commit']}
                job=http('/native/pr-evidence',{'action':'create','selection':selection,'runTests':True,'advice':False,'idempotencyKey':ci['job_key']})['job']
                ci.update(job_id=job['id'],state='admitted');save()
            inspection={'repository':key,'repositoryId':item['repository_id'],'jobId':ci['job_id']}
            for _ in range(240):
                job=http('/native/pr-evidence',{**inspection,'action':'status'})['job']
                if job['state'] in ['SUCCEEDED','REFUSED','EXPIRED']: break
                time.sleep(1)
            if job['state']!='SUCCEEDED': raise RuntimeError('Demo CI did not finish: '+job['state'])
            tests=http('/native/pr-evidence',{**inspection,'action':'report'})['report'].get('tests',{})
            ci['tests']=tests;save()
            if tests.get('state')!='PASSED' or tests.get('exitCode')!=0 or tests.get('cleanup')!='destroyed' or tests.get('commitId')!=ci['commit'] or not tests.get('image'): raise RuntimeError('Demo package CI failed; inspect its retained test report')
            packages=http('/native/repository-packages',{'repository':key,'repositoryId':item['repository_id'],'action':'status'})
            if packages.get('provider')!='cloudflare' or not any(a['digest']==tests['image']['digest'] for a in packages.get('artifacts',[])): raise RuntimeError('Published artifact digest differs')
            ci.update(state='verified',image=tests['image'],url=settings['origin']+'/'+key['owner']+'/'+name+'/pull/'+str(ci['number']))
            ci.pop('error',None)
        except Exception as error:
            ci.update(state='failed',error=str(error)[:256])
        finally:
            if token: cf('artifacts','namespaces','tokens','revoke',token['id'],'--namespace',settings['namespace'],'--force')
            save()
        print(json.dumps({'repository':name,'ci':ci['state'],'error':ci.get('error')}),flush=True)
    return 0 if all(next(r for r in results['repositories'] if r['name']==name)['ci']['state']=='verified' for name,_ in sources) else 1
