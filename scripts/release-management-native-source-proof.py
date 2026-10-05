#!/usr/bin/env python3
"""Qualify source release handlers against an owned native fixture; no Docker jobs."""
import argparse,json,os,secrets,subprocess,sys,time
from pathlib import Path
sys.dont_write_bytecode=True
import smoke

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--compose-root',type=Path,required=True);args=p.parse_args();os.umask(0o077);args.output.mkdir(parents=True,exist_ok=False);smoke.ROOT=args.compose_root
 smoke.admin=lambda *items:smoke.command('docker','compose','exec','-T','gitea','gitea','--config','/etc/gitea/app.ini','admin','user',*items,cwd=args.compose_root)
 name='golf-release-source-'+secrets.token_hex(4);created=False;token='';report={'passed':False,'ownedUserPurged':False,'productionHTTPHandlers':True,'newDockerJobs':0}
 try:
  smoke.admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');created=True
  token=smoke.admin('generate-access-token','--username',name,'--token-name',name,'--scopes','write:user,write:repository','--raw')
  user=smoke.provider(token,'GET','user');repo=smoke.provider(token,'POST','user/repos',{'name':'releases','private':True,'auto_init':True},201);base='repos/'+repo['full_name'];smoke.wait_for_push(token,repo['full_name'])
  release=smoke.provider(token,'POST',base+'/releases',{'tag_name':'v1','target_commitish':repo['default_branch'],'name':'Initial owned release','body':'Native qualification fixture','draft':False,'prerelease':False},201)
  fixture={'Native':smoke.GITEA,'Token':token,'Owner':name,'Repository':'releases','RepositoryID':str(repo['id']),'OwnerID':str(user['id']),'ReleaseID':str(release['id'])}
  env={**os.environ,'GOLF_TEST_RELEASE_OPERATION_NATIVE_CASE':json.dumps(fixture)}
  run=subprocess.run(['go','test','-race','-p','1','./internal/server','-run','^TestReleaseOperationsActualNative$','-count=1','-v'],env=env,text=True,capture_output=True,timeout=120)
  assert token not in run.stdout+run.stderr,'Native credential diagnostic withheld'
  (args.output/'source-native.log').write_text(run.stdout+run.stderr)
  assert run.returncode==0,'Native source qualification failed; inspect owned redacted log'
  smoke.provider(token,'GET',base+'/releases/'+str(release['id']),expected=404);tag=smoke.provider(token,'GET',base+'/tags/v1');assert tag['name']=='v1'
  report.update(passed=True,nativeVersion=smoke.provider(token,'GET','version')['version'],operations=['edit','upload','rename_asset','delete_asset','delete'],originalReplayAndInspection=True,tagPreserved=True)
 finally:
  if created:
   smoke.admin('delete','--username',name,'--purge');smoke.request(smoke.client(),'GET',smoke.GITEA+'/api/v1/users/'+name,expected=404);report['ownedUserPurged']=True
  (args.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
 print('PASS actual native release source qualification; owned actor purged')
if __name__=='__main__':main()
