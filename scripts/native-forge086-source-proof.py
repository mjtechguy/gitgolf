#!/usr/bin/env python3
"""Owned native public clone/package proof; private provider auth is fixture-only."""
import argparse,hashlib,json,os,secrets,subprocess,sys,urllib.request
from pathlib import Path
sys.dont_write_bytecode=True
import smoke
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--compose-root',type=Path,required=True);a=p.parse_args();os.umask(0o077);a.output.mkdir(parents=True,exist_ok=False);smoke.ROOT=a.compose_root
smoke.admin=lambda *items:smoke.command('docker','compose','exec','-T','forgejo','forgejo','--config','/var/lib/gitea/custom/conf/app.ini','admin','user',*items,cwd=a.compose_root)  # Forgejo's upstream path
name='golf-native086-'+secrets.token_hex(4);created=False;token='';report={'ownedUser':name,'passed':False,'ownedUserPurged':False,'newDockerJobs':0,'realPrivateProviderQualified':False,'providerAuthorization':'deterministic fixed-origin selected project fixture','sourceRevision':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'sourceFileSHA256':{x:hashlib.sha256(Path(x).read_bytes()).hexdigest() for x in ['api/golf/v1/golf.proto','internal/server/provider_import086.go','internal/server/package_operations086.go','internal/server/forge086_native_test.go','internal/server/rpc.go','internal/server/repository_wiki.go','internal/server/repository_wiki_operations.go','internal/server/wiki_authority086.go','internal/server/repository_mirror_operations.go','internal/server/mirror_observation086.go','internal/server/provider_key_rotation086.go','internal/server/key_operations.go','internal/server/database/queries/keyring.sql','internal/server/database/migrations/202610050086_provider_imports_and_packages.sql']}}
def public_json(url):
 r=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'Golf-owned-native086-qualifier'})
 with urllib.request.urlopen(r,timeout=15) as response:return json.load(response)
try:
 source=public_json('https://api.github.com/repos/octocat/Hello-World');assert source['private'] is False and source['clone_url']=='https://github.com/octocat/Hello-World.git';head=public_json('https://api.github.com/repos/octocat/Hello-World/branches/'+source['default_branch'])
 smoke.admin('create','--username',name,'--email',name+'@example.invalid','--random-password','--must-change-password=false');created=True
 token=smoke.admin('generate-access-token','--username',name,'--token-name',name,'--scopes','write:user,write:repository,write:package,write:organization','--raw')
 user=smoke.provider(token,'GET','user');private=smoke.provider(token,'POST','user/repos',{'name':'owned-private','private':True,'auto_init':True,'has_wiki':True},201);public=smoke.provider(token,'POST','user/repos',{'name':'owned-public','private':False,'auto_init':True,'has_wiki':True},201)
 mirror=smoke.provider(token,'POST','repos/migrate',{'clone_addr':'https://github.com/octocat/Hello-World.git','repo_name':'owned-mirror','repo_owner':name,'private':True,'mirror':True,'mirror_interval':'1h'},201)
 fixture={'Mirror':mirror['name'],'MirrorID':str(mirror['id']),'Native':smoke.FORGE,'Token':token,'Owner':name,'PrivateRepository':private['name'],'PublicRepository':public['name'],'PrivateID':str(private['id']),'PublicID':str(public['id']),'OwnerID':str(user['id']),'Source':source,'Head':head}
 run=subprocess.run(['go','test','-race','-p','1','./internal/server','-run','^TestForge086NativeActual$','-count=1','-v'],env={**os.environ,'GOLF_TEST_NATIVE086_CASE':json.dumps(fixture)},capture_output=True,text=True,timeout=150)
 assert token not in run.stdout+run.stderr,'Sensitive diagnostic withheld';(a.output/'native.log').write_text(run.stdout+run.stderr);assert run.returncode==0,'Native qualification failed'
 report.update(passed=True,actualNativePublicClone=True,privateDestinationHeadEquality=True,publicNamespaceExplicitAcknowledgement=True,privateRepositoryPublicNamespaceBlocked=True,boundedGenericPublishLinkDownload=True,originalReplayInspection=True,currentWikiSidebarFooter=True,mirrorSubsequentSyncDefaultHeadEquality=True,nativeVersion=smoke.provider(token,'GET','version')['version'])
finally:
 if created:
  smoke.admin('delete','--username',name,'--purge');smoke.request(smoke.client(),'GET',smoke.FORGE+'/api/v1/users/'+name,expected=404);report['ownedUserPurged']=True
 (a.output/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS native086 public clone and generic package qualification; fixture purged')
