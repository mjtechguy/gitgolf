#!/usr/bin/env python3
"""Native wiki write/history and package read qualification, owned fixtures only."""
import argparse,hashlib,json,os,secrets,subprocess,sys,urllib.request
from pathlib import Path
sys.dont_write_bytecode=True
import smoke
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--compose-root',type=Path,required=True);a=p.parse_args();os.umask(0o077);a.output.mkdir(parents=True,exist_ok=False);smoke.ROOT=a.compose_root
smoke.admin=lambda *items:smoke.command('docker','compose','exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*items,cwd=a.compose_root)
name='golf-native078-'+secrets.token_hex(4);created=False;token='';org=None;report={'ownedUser':name,'ownedOrganization':name+'-org','passed':False,'ownedUserPurged':False,'newDockerJobs':0,'sourceRevision':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'sourceFileSHA256':{x:hashlib.sha256(Path(x).read_bytes()).hexdigest() for x in ['api/golf/v1/golf.proto','internal/server/repository_wiki_operations.go','internal/server/repository_wiki_operations_test.go','internal/server/repository_packages.go','internal/server/organization_labels.go','internal/server/repository_mirror_operations.go','internal/server/repository_mirrors.go','internal/server/repository_wiki_history.go','internal/server/repository_lifecycle.go','internal/server/rpc.go','internal/server/database/migrations/202610050078_repository_wiki_operations.sql']}}
try:
 smoke.admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');created=True
 token=smoke.admin('generate-access-token','--username',name,'--token-name',name,'--scopes','write:user,write:repository,write:package,write:organization','--raw')
 user=smoke.provider(token,'GET','user');repo=smoke.provider(token,'POST','user/repos',{'name':'forge078','private':True,'auto_init':True,'has_wiki':True},201);smoke.wait_for_push(token,repo['full_name'])
 r=urllib.request.Request(smoke.GITEA+'/api/packages/'+name+'/generic/owned-demo/1.0/hello.txt',data=b'Hello packages\n',method='PUT',headers={'Authorization':'token '+token,'Content-Type':'application/octet-stream'})
 with urllib.request.urlopen(r,timeout=15) as response:assert response.status==201
 smoke.provider(token,'POST','packages/'+name+'/generic/owned-demo/-/link/forge078',expected=201)
 org=smoke.provider(token,'POST','orgs',{'username':name+'-org','visibility':'private'},201)
 mirror=smoke.provider(token,'POST','repos/migrate',{'clone_addr':'https://github.com/octocat/Hello-World.git','repo_name':'owned-mirror','repo_owner':name,'private':True,'mirror':True,'mirror_interval':'1h'},201)
 fixture={'Organization':org['username'],'OrganizationID':str(org['id']),'Mirror':mirror['name'],'MirrorID':str(mirror['id']),'Native':smoke.GITEA,'Token':token,'Owner':name,'Repository':'forge078','RepositoryID':str(repo['id']),'OwnerID':str(user['id'])}
 run=subprocess.run(['go','test','-race','-p','1','./internal/server','-run','^TestNative078Actual$','-count=1','-v'],env={**os.environ,'GOLF_TEST_NATIVE078_CASE':json.dumps(fixture)},capture_output=True,text=True,timeout=150)
 assert token not in run.stdout+run.stderr,'Sensitive diagnostic withheld';(a.output/'native.log').write_text(run.stdout+run.stderr);assert run.returncode==0,'Native qualification failed'
 report.update(passed=True,wikiCreateEditDelete=True,wikiHistory=True,packageInventoryFiles=True,organizationLabelCRUD=True,mirrorIntervalChange=True,mirrorSynchronizationQueueAcceptanceOnly=True,originalReplayInspection=True,nativeVersion=smoke.provider(token,'GET','version')['version'])
finally:
 if org is not None:
  smoke.provider(token,'DELETE','orgs/'+org['username'],expected=204);report['ownedOrganizationPurged']=True
 if created:
  smoke.admin('delete','--username',name,'--purge');smoke.request(smoke.client(),'GET',smoke.GITEA+'/api/v1/users/'+name,expected=404);report['ownedUserPurged']=True
 (a.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS native078 wiki and package source qualification; fixture purged')
