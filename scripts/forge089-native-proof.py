#!/usr/bin/env python3
"""Qualify native pending append, one-commit batch/rename and discussion attachments.
Uses retained native Forgejo plus an isolated host PostgreSQL schema; no runtime
restart, resource increase, CI, model execution or direct forge storage writes.
"""
import argparse,hashlib,json,os,secrets,subprocess,sys,tempfile
from pathlib import Path
sys.dont_write_bytecode=True
from smoke import ROOT,FORGE,command,provider,wait_for_push

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--stack-root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();stack=a.stack_root.resolve();os.umask(0o077)
 assert os.environ.get('GOLF_TEST_DATABASE_URL'),'Supply owned isolated host PostgreSQL';a.output.mkdir(parents=True,exist_ok=False)
 report={'passed':False,'ownedFixturesPurged':False,'dockerResourcesCreated':0};users=[];actors={};repos=[];org=None;prefix='golf-review084-'+secrets.token_hex(4)
 def admin(*v):return command('docker','compose','--project-directory',str(stack),'--file',str(stack/'compose.yaml'),'--env-file',str(stack/'.env'),'exec','-T','forgejo','forgejo','--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*v)  # Forgejo's upstream path
 try:
  for role in ('owner','reviewer'):
   name=prefix+'-'+role;admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');users.append(name)
   token=admin('generate-access-token','--username',name,'--token-name',prefix,'--scopes','write:user,write:repository,write:issue,write:organization','--raw');actors[role]={'name':name,'token':token}
  owner,reviewer=actors['owner'],actors['reviewer'];org=provider(owner['token'],'POST','orgs',{'username':prefix+'-org','visibility':'private'},expected=201)
  repo=provider(owner['token'],'POST','orgs/'+org['name']+'/repos',{'name':'private','private':True,'auto_init':True},expected=201);base='repos/'+repo['full_name'];repos.append((owner['token'],base));wait_for_push(owner['token'],repo['full_name'])
  provider(owner['token'],'PUT',base+'/collaborators/'+reviewer['name'],{'permission':'write'},expected=204)
  team=provider(owner['token'],'POST','orgs/'+org['name']+'/teams',{'name':'reviewers','permission':'read','units':['repo.pulls'],'units_map':{'repo.pulls':'read'},'visibility':'public'},expected=201)
  provider(owner['token'],'PUT','teams/'+str(team['id'])+'/repos/'+repo['full_name'],expected=204)
  with tempfile.TemporaryDirectory(prefix='golf-review084-') as d:
   f=Path(d)/'fixture.json';fd=os.open(f,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w') as out:json.dump({'URL':FORGE,'Owner':owner['name'],'Reviewer':reviewer['name'],'OwnerToken':owner['token'],'ReviewerToken':reviewer['token'],'Organization':org['name'],'Branch':repo['default_branch'],'RepositoryID':repo['id'],'TeamID':team['id']},out)
   result=subprocess.run(['go','test','-race','./internal/server','-run','^TestReviewAuthoringNativeProof$','-count=1','-v'],cwd=ROOT,env={**os.environ,'GOLF_REVIEW_INTERACTIONS_NATIVE_PROOF':str(f)},capture_output=True,text=True,timeout=240)
   safe=[]
   for line in (result.stdout+result.stderr).splitlines():
    if any(actor['token'] in line for actor in actors.values()):raise RuntimeError('private diagnostic withheld')
    safe.append(line)
   (a.output/'go-test.log').write_text('\n'.join(safe)+'\n');assert '=== RUN   TestReviewAuthoringNativeProof' in result.stdout,'Wrong native qualifier selected';assert result.returncode==0,'Native review interactions failed; inspect private receipt'
  report['sourceFiles']={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ('api/golf/v1/golf.proto','api/golf/v1/forge089.proto','internal/server/pull_review_authoring.go','internal/server/pull_review_authoring_receipt.go','internal/server/pull_review_authoring_native_test.go','internal/server/forge089_native_test.go','internal/server/repository_file_batch.go','internal/server/repository_file_mutations.go','internal/server/discussion_attachments.go','internal/server/discussion_attachment_upload.go','internal/server/discussion_resource_operations.go','internal/server/repository_release_operations.go','internal/server/database/migrations/202610050089_forge_consumers.sql','internal/server/rpc.go')}
  report.update(passed=True,nativeVersion=provider(owner['token'],'GET','version')['version'],sourceRevision=command('git','rev-parse','HEAD'),scope='Actual production HTTP pending lifecycle and exact saved append with retained summary/children; one-parent three-file create then rename/update/delete, stale refusal and original replay; current underlying discussion attachment inventory, exact mediated bytes and wrong association refusal. Own PR-body and ordinary-comment multipart uploads with independent byte readback, original replay/inspection and stale refusal. No protected writes, native HEAD/attachment-version CAS, ranged suggestions, replacement/deletion or execution.')
 finally:
  errors=[]
  for token,base in reversed(repos):
   try:provider(token,'DELETE',base,expected=204)
   except Exception:errors.append('owned repository')
  if org:
   try:provider(actors['owner']['token'],'DELETE','orgs/'+org['name'],expected=204)
   except Exception:errors.append('owned organization')
  for name in reversed(users):
   try:admin('delete','--username',name,'--purge')
   except Exception:errors.append('owned actor')
  report['ownedFixturesPurged']=not errors;(a.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n');assert not errors,'Owned cleanup failed'
 print('PASS: supported native review authoring and owned fixture cleanup.')
if __name__=='__main__':main()
